import {
  TOOL_CALL_KINDS,
  firstUserPrompt,
  isHarnessMessage,
  splitName,
  toolNameOf,
} from "./execution-story";
import type { RawTraceEvent } from "./types";

/**
 * Prompt optimizer: when is a subagent worth its context cost?
 *
 * Two questions, answered from event metadata only:
 *
 * 1. For every spawn that already happened, was it worth it? A child lane
 *    absorbs its own tool results and model turns; none of that lands in the
 *    parent's context. That absorbed volume is the saving; the child's fresh
 *    context (system prompt share + task assignment) is the cost.
 * 2. At the current watermark, should the root agent spawn now? Only signals
 *    visible without the prompt body are used: tool failures and repeated
 *    calls (evidence gaps worth isolating) and context pressure (how many
 *    model turns the root lane has already accumulated).
 *
 * Token figures are estimates. Names are capped at 240 characters and result
 * bodies are withheld, so every number is a floor, labelled as such in the UI.
 */

/** Rough tokens a child lane keeps out of the parent per absorbed event. */
const TOKENS_PER_ABSORBED_TOOL_RESULT = 180;
const TOKENS_PER_ABSORBED_MODEL_TURN = 90;
/** Fixed context a fresh child pays before doing anything useful. */
const CHILD_FIXED_OVERHEAD_TOKENS = 240;
/** Prospective savings per signal when recommending a spawn at the watermark. */
const TOKENS_SAVED_PER_FAILURE = 120;
const TOKENS_SAVED_PER_REPEAT = 80;
const TOKENS_SAVED_PER_PRESSURE_TURN = 150;
const CONTEXT_PRESSURE_FREE_TURNS = 6;

export type PromptOptimizationDecision = "spawn" | "hold";
export type SpawnVerdict = "worth" | "marginal" | "wasteful" | "pending";

export interface SpawnAccounting {
  handoffEventId: string;
  seq: number;
  occurredAt: string;
  parentAgentId: string;
  label: string;
  childAgentIds: string[];
  childrenStarted: number;
  childrenJoined: number;
  childToolCalls: number;
  childToolResults: number;
  childModelCalls: number;
  childFailures: number;
  parentModelCallsBefore: number;
  spawnCostTokens: number;
  absorbedTokens: number;
  netTokens: number;
  verdict: SpawnVerdict;
}

export interface PromptOptimizationResult {
  decision: PromptOptimizationDecision;
  traceComplete: boolean;
  score: number;
  promptTokens: number;
  rootAgentId: string | null;
  independentTasks: number;
  toolFailures: number;
  repeatedToolCalls: number;
  contextPressure: number;
  activeChildren: number;
  spawnCostTokens: number;
  expectedSavedTokens: number;
  reasons: string[];
  spawns: SpawnAccounting[];
}

function seqOf(event: RawTraceEvent): number {
  return Number(event.ingestSeq);
}

/** CJK runs tokenize near one token per character; everything else near four characters per token. */
export function estimateTokens(value: string): number {
  const text = value.trim();
  const cjk =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length ?? 0;
  return Math.max(1, cjk + Math.ceil((text.length - cjk) / 4));
}

function stringAttr(event: RawTraceEvent, key: string): string | null {
  const value = event.attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringListAttr(event: RawTraceEvent, key: string): string[] {
  const value = event.attributes[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function isFailedResult(event: RawTraceEvent): boolean {
  return (
    event.kind === "tool_result" && (event.status === "error" || event.attributes.failed === true)
  );
}

/**
 * Tokens in a user message. The name preview is capped at 240 characters, so
 * when the sanitized payload is known its byte length (`{"text": …}` minus the
 * wrapper) gives a better floor for long prompts.
 */
export function promptTokensOf(event: RawTraceEvent): number {
  const preview = splitName(event.name).detail ?? event.name;
  const fromPreview = estimateTokens(preview);
  if (!isTruncatedName(event.name)) return fromPreview;
  const bytes = event.payloadRef?.byteLength ?? 0;
  const fromPayload = bytes > 0 ? Math.ceil(Math.max(0, bytes - 11) / 4) : 0;
  return Math.max(fromPreview, fromPayload);
}

/**
 * Adapters cut long previews with an ellipsis around 200 characters and the
 * schema caps `name` at 240; either way the preview is not the whole text.
 */
function isTruncatedName(name: string): boolean {
  return name.endsWith("…") || name.length >= 200;
}

/** The root lane: the agent that received the author's prompt. */
export function rootAgentOf(events: readonly RawTraceEvent[]): string | null {
  return firstUserPrompt(events)?.agentId ?? null;
}

/**
 * Model turns in a lane. Adapters that record `model_call` events give the
 * exact count; Codex does not, so each narrated assistant message and each
 * tool call stands in for one turn there.
 */
export function turnEvents(lane: readonly RawTraceEvent[]): RawTraceEvent[] {
  const explicit = lane.filter((event) => event.kind === "model_call");
  if (explicit.length > 0) return explicit;
  // Claude Code writes one assistant record per turn, tool-use turns included;
  // Codex writes only the narrated ones and a tool call per turn. Whichever
  // series is longer is the closer count.
  const assistant = lane.filter(
    (event) =>
      event.kind === "assistant_message" &&
      !isHarnessMessage(splitName(event.name).detail ?? event.name),
  );
  const calls = lane.filter((event) => TOOL_CALL_KINDS.has(event.kind));
  return assistant.length >= calls.length ? assistant : calls;
}

export function modelTurns(lane: readonly RawTraceEvent[]): number {
  return turnEvents(lane).length;
}

export function accountSpawns(events: readonly RawTraceEvent[]): SpawnAccounting[] {
  const ordered = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  const byAgent = new Map<string, RawTraceEvent[]>();
  for (const event of ordered) {
    if (!event.agentId) continue;
    const lane = byAgent.get(event.agentId) ?? [];
    lane.push(event);
    byAgent.set(event.agentId, lane);
  }

  return ordered
    .filter((event) => event.kind === "agent_handoff")
    .map((handoff) => {
      const parentAgentId = handoff.agentId ?? "system";
      const seq = seqOf(handoff);
      const childAgentIds = stringListAttr(handoff, "spawnedAgentIds");
      const { detail } = splitName(handoff.name);

      let childrenStarted = 0;
      let childrenJoined = 0;
      let childToolCalls = 0;
      let childToolResults = 0;
      let childModelCalls = 0;
      let childFailures = 0;
      let assignmentTokens = 0;
      for (const childId of childAgentIds) {
        for (const event of byAgent.get(childId) ?? []) {
          if (seqOf(event) < seq) continue;
          if (event.kind === "agent_start") childrenStarted += 1;
          else if (event.kind === "agent_end") childrenJoined += 1;
          else if (TOOL_CALL_KINDS.has(event.kind)) childToolCalls += 1;
          else if (event.kind === "tool_result") {
            childToolResults += 1;
            if (isFailedResult(event)) childFailures += 1;
          } else if (event.kind === "model_call") childModelCalls += 1;
          else if (event.kind === "user_message" && stringAttr(event, "assignedBy"))
            assignmentTokens += estimateTokens(splitName(event.name).detail ?? event.name);
        }
      }
      const parentModelCallsBefore = modelTurns(
        (byAgent.get(parentAgentId) ?? []).filter((event) => seqOf(event) < seq),
      );

      const spawnCostTokens = childAgentIds.length * CHILD_FIXED_OVERHEAD_TOKENS + assignmentTokens;
      const absorbedTokens =
        childToolResults * TOKENS_PER_ABSORBED_TOOL_RESULT +
        childModelCalls * TOKENS_PER_ABSORBED_MODEL_TURN;
      const netTokens = absorbedTokens - spawnCostTokens;

      let verdict: SpawnVerdict;
      if (childrenStarted === 0) verdict = "pending";
      else if (netTokens >= spawnCostTokens) verdict = "worth";
      else if (netTokens >= 0) verdict = "marginal";
      else verdict = "wasteful";

      return {
        handoffEventId: handoff.id,
        seq,
        occurredAt: handoff.occurredAt,
        parentAgentId,
        label: detail ?? handoff.name,
        childAgentIds,
        childrenStarted,
        childrenJoined,
        childToolCalls,
        childToolResults,
        childModelCalls,
        childFailures,
        parentModelCallsBefore,
        spawnCostTokens,
        absorbedTokens,
        netTokens,
        verdict,
      };
    });
}

export function evaluatePromptOptimization({
  events,
}: {
  events: readonly RawTraceEvent[];
}): PromptOptimizationResult {
  const ordered = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  const rootAgentId = rootAgentOf(ordered);
  const rootLane = rootAgentId
    ? ordered.filter((event) => event.agentId === rootAgentId)
    : ordered.filter((event) => !event.agentId);

  const firstPrompt = firstUserPrompt(ordered);
  const promptTokens = firstPrompt ? promptTokensOf(firstPrompt) : 0;

  const spawns = accountSpawns(ordered);
  const spawnedIds = new Set(spawns.flatMap((spawn) => spawn.childAgentIds));
  for (const event of ordered)
    if (event.kind === "agent_start" && event.agentId && stringAttr(event, "parentAgentId"))
      spawnedIds.add(event.agentId);
  const independentTasks = spawnedIds.size;

  const started = new Set<string>();
  const ended = new Set<string>();
  for (const event of ordered) {
    if (!event.agentId || !spawnedIds.has(event.agentId)) continue;
    if (event.kind === "agent_start") started.add(event.agentId);
    if (event.kind === "agent_end") ended.add(event.agentId);
  }
  const activeChildren = [...started].filter((id) => !ended.has(id)).length;

  const rootCalls = rootLane.filter((event) => TOOL_CALL_KINDS.has(event.kind));
  const toolFailures = rootLane.filter(
    (event) =>
      (TOOL_CALL_KINDS.has(event.kind) && event.status === "error") || isFailedResult(event),
  ).length;
  const rootCallNames = rootCalls.map((event) => `${toolNameOf(event)}\u0000${event.name}`);
  const repeatedToolCalls = rootCallNames.length - new Set(rootCallNames).size;
  const contextPressure = modelTurns(rootLane);

  const spawnCostTokens = CHILD_FIXED_OVERHEAD_TOKENS + Math.ceil(promptTokens * 0.5);
  const expectedSavedTokens =
    toolFailures * TOKENS_SAVED_PER_FAILURE +
    repeatedToolCalls * TOKENS_SAVED_PER_REPEAT +
    Math.max(0, contextPressure - CONTEXT_PRESSURE_FREE_TURNS) * TOKENS_SAVED_PER_PRESSURE_TURN;

  const score = Math.min(
    100,
    toolFailures * 14 +
      repeatedToolCalls * 8 +
      Math.max(0, contextPressure - CONTEXT_PRESSURE_FREE_TURNS) * 6 +
      (promptTokens > 0 && promptTokens < 40 ? 10 : 0),
  );

  const traceComplete = ordered.some((event) => event.kind === "trace_complete");

  const reasons: string[] = [];
  if (traceComplete)
    reasons.push(
      "Trace is complete, so there is no dispatch left; the ledger below is a post-mortem of this run",
    );
  if (activeChildren > 0)
    reasons.push(
      `${activeChildren} child agent${activeChildren === 1 ? " is" : "s are"} still running; wait for the join instead of spawning again`,
    );
  if (toolFailures > 0)
    reasons.push(
      `Root agent has ${toolFailures} failed tool call${toolFailures === 1 ? "" : "s"}; worth isolating that investigation in a child`,
    );
  if (repeatedToolCalls > 0)
    reasons.push(
      `Root agent repeated the same tool action ${repeatedToolCalls} time${repeatedToolCalls === 1 ? "" : "s"}`,
    );
  if (contextPressure > CONTEXT_PRESSURE_FREE_TURNS)
    reasons.push(
      `Root agent has taken ${contextPressure} model turns; its context is getting heavy`,
    );
  const decision: PromptOptimizationDecision =
    !traceComplete && activeChildren === 0 && expectedSavedTokens >= spawnCostTokens
      ? "spawn"
      : "hold";
  if (decision === "spawn" && promptTokens > 0 && promptTokens < 40)
    reasons.push(
      `Prompt is only ~${promptTokens} tokens; write the sub-task boundary before dispatching`,
    );
  if (reasons.length === 0)
    reasons.push(
      "No failure, repetition or context-pressure signal on the root lane; keep going with the current agent",
    );

  return {
    decision,
    traceComplete,
    score,
    promptTokens,
    rootAgentId,
    independentTasks,
    toolFailures,
    repeatedToolCalls,
    contextPressure,
    activeChildren,
    spawnCostTokens,
    expectedSavedTokens,
    reasons,
    spawns,
  };
}
