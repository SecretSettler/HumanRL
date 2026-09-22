import { TOOL_CALL_KINDS, firstUserPrompt, splitName, toolNameOf } from "./execution-story";
import {
  promptTokensOf,
  rootAgentOf,
  turnEvents,
  type PromptOptimizationResult,
  type SpawnAccounting,
} from "./prompt-optimizer";
import type { RawTraceEvent } from "./types";

/**
 * Prompt review: what the initial prompt caused, read back from the trace.
 *
 * Each finding ties a pattern in the events to something the author of the
 * prompt can change next time. Findings cite event ids so the UI can jump to
 * the evidence. Only event metadata is used; the prompt body itself is shown
 * separately, fetched from the sanitized payload on demand.
 */

export type FindingSeverity = "high" | "medium" | "info";

export interface PromptFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  suggestion: string;
  eventIds: string[];
}

export interface PromptReview {
  promptEvent: RawTraceEvent | null;
  promptPreview: string;
  promptTokens: number;
  findings: PromptFinding[];
}

/** Below this many model turns before the first spawn, the orchestrator did not have to invent the task. */
const PLANNING_TURNS_THRESHOLD = 3;
/** A prompt shorter than this rarely states deliverable, constraints and stop condition. */
const SHORT_PROMPT_TOKENS = 60;
/** More post-join turns than this means the orchestrator did the assembly itself. */
const POST_JOIN_TURNS_THRESHOLD = 8;
/** A run with this many root tool calls and no subagent is worth a note about delegation. */
const UNDELEGATED_CALLS_THRESHOLD = 20;
/** One wave taking more than this share of all absorbed work dominates the run. */
const DOMINANT_WAVE_SHARE = 0.6;
/** Task assignments this many times larger than the prompt mean the orchestrator wrote the task. */
const INVENTED_TASK_RATIO = 3;
/** Control-flow tools whose "action" is not work that lanes could be duplicating. */
const CONTROL_TOOLS: ReadonlySet<string> = new Set(["yield", "hub", "task", "join", "spawn"]);

function seqOf(event: RawTraceEvent): number {
  return Number(event.ingestSeq);
}

function stringAttr(event: RawTraceEvent, key: string): string | null {
  const value = event.attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isFailedResult(event: RawTraceEvent): boolean {
  return (
    event.kind === "tool_result" && (event.status === "error" || event.attributes.failed === true)
  );
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function reviewPrompt({
  events,
  optimization,
}: {
  events: readonly RawTraceEvent[];
  optimization: PromptOptimizationResult;
}): PromptReview {
  const ordered = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  const rootAgentId = rootAgentOf(ordered);
  const promptEvent = firstUserPrompt(ordered);
  const promptPreview = promptEvent ? (splitName(promptEvent.name).detail ?? promptEvent.name) : "";
  const promptTokens = promptEvent ? promptTokensOf(promptEvent) : 0;
  const findings: PromptFinding[] = [];
  if (!promptEvent) return { promptEvent, promptPreview, promptTokens, findings };

  const rootLane = ordered.filter((event) => event.agentId === rootAgentId);
  const spawns = optimization.spawns;
  const firstSpawnSeq = spawns[0]?.seq ?? Number.POSITIVE_INFINITY;

  // 1. Tools that were reached for but do not exist in the environment.
  const failedResults = ordered.filter(isFailedResult);
  const missing = failedResults.filter((event) =>
    /not found|unknown tool|not available/iu.test(event.name),
  );
  if (missing.length > 0) {
    const tools = [...new Set(missing.map(toolNameOf))];
    const lanes = new Set(missing.map((event) => event.agentId ?? "system"));
    findings.push({
      id: "missing-tools",
      severity: "high",
      title: `Agents reached for ${plural(tools.length, "tool")} that do not exist: ${listNames(tools)}`,
      detail: `${plural(missing.length, "call")} failed with "not found" across ${plural(lanes.size, "lane")} (${listNames([...lanes])}). Each one cost a model turn and a retry.`,
      suggestion:
        "Name the tools the environment actually has, or drop the expectation behind those calls (for example, machine verification when there is no code runner).",
      eventIds: missing.map((event) => event.id),
    });
  } else if (failedResults.length > 0) {
    const lanes = new Set(failedResults.map((event) => event.agentId ?? "system"));
    findings.push({
      id: "tool-failures",
      severity: "medium",
      title: `${plural(failedResults.length, "tool call")} failed`,
      detail: `Failures landed in ${listNames([...lanes])}. Look at the results to see whether the prompt set up work the environment could not do.`,
      suggestion:
        "Check the failed results; if the prompt asked for something unavailable, say so up front.",
      eventIds: failedResults.map((event) => event.id),
    });
  }

  // 2. A short prompt the orchestrator had to turn into a task itself.
  const rootTurns = turnEvents(rootLane);
  const planningTurns = rootTurns.filter((event) => seqOf(event) < firstSpawnSeq);
  const planningReads = rootLane.filter(
    (event) => TOOL_CALL_KINDS.has(event.kind) && seqOf(event) < firstSpawnSeq,
  );
  const assignments = ordered.filter(
    (event) => event.kind === "user_message" && stringAttr(event, "assignedBy"),
  );
  const assignmentTokens = assignments.reduce((sum, event) => sum + promptTokensOf(event), 0);
  const inventedTask =
    assignments.length > 0 && assignmentTokens >= INVENTED_TASK_RATIO * Math.max(1, promptTokens);
  if (inventedTask) {
    findings.push({
      id: "short-prompt",
      severity: "medium",
      title: `Prompt is ~${promptTokens} tokens; the orchestrator wrote ~${assignmentTokens} tokens of task assignments to fill in what it left out`,
      detail: `${plural(planningTurns.length, "turn")} and ${plural(planningReads.length, "read")} went into working that out before the first spawn. Open an assignment to see the deliverable, slice and constraints it had to invent for each lane.`,
      suggestion:
        "Write those into the prompt yourself: the deliverable, how to slice the work, the constraints, and when to stop. The assignments are a draft of the prompt you should have sent.",
      eventIds: [
        ...assignments.map((event) => event.id),
        ...planningTurns.map((event) => event.id),
      ],
    });
  } else if (
    promptTokens < SHORT_PROMPT_TOKENS &&
    planningTurns.length >= PLANNING_TURNS_THRESHOLD
  ) {
    findings.push({
      id: "short-prompt",
      severity: "medium",
      title: `Prompt is ~${promptTokens} tokens; the orchestrator spent ${plural(planningTurns.length, "turn")} and ${plural(planningReads.length, "read")} working out what to do`,
      detail: "Scope, deliverable and stop condition were all decided by the orchestrator.",
      suggestion:
        "State the deliverable, the constraints and when to stop. That text is what the orchestrator had to author on your behalf; writing it yourself removes those planning turns.",
      eventIds: planningTurns.map((event) => event.id),
    });
  }

  // 3. Spawns that did not pay for themselves.
  const poor = spawns.filter(
    (spawn) => spawn.verdict === "wasteful" || spawn.verdict === "marginal",
  );
  if (poor.length > 0) {
    findings.push({
      id: "poor-spawns",
      severity: "medium",
      title: `${plural(poor.length, "spawn wave")} did not pay for the fresh context`,
      detail: poor
        .map(
          (spawn) =>
            `"${spawn.label}" (#${spawn.seq}): ${spawn.childAgentIds.length} agents absorbed ≥${spawn.absorbedTokens} tokens against a cost of ≥${spawn.spawnCostTokens}.`,
        )
        .join(" "),
      suggestion:
        "Ask for subagents only where the work is independent and heavy enough to outweigh a fresh context; small or sequential pieces are cheaper inside the current agent.",
      eventIds: poor.map((spawn) => spawn.handoffEventId),
    });
  }

  // 4. One wave dominating the budget: is that what the prompt was for?
  const absorbedTotal = spawns.reduce((sum, spawn) => sum + spawn.absorbedTokens, 0);
  const dominant: SpawnAccounting | undefined = spawns.find(
    (spawn) => absorbedTotal > 0 && spawn.absorbedTokens / absorbedTotal >= DOMINANT_WAVE_SHARE,
  );
  if (dominant && spawns.length > 1) {
    const share = Math.round((dominant.absorbedTokens / absorbedTotal) * 100);
    findings.push({
      id: "dominant-wave",
      severity: "info",
      title: `${share}% of the delegated work went to "${dominant.label}"`,
      detail: `${listNames(dominant.childAgentIds)} produced ≥${dominant.absorbedTokens} of the ≥${absorbedTotal} absorbed tokens across ${plural(spawns.length, "wave")}.`,
      suggestion:
        "If that wave is a side quest rather than the goal of the prompt, run it as its own prompt so the main task keeps the budget.",
      eventIds: [dominant.handoffEventId],
    });
  }

  // 5. Same action repeated in several lanes: overlapping assignments.
  const actionLanes = new Map<string, Set<string>>();
  const actionEvents = new Map<string, string[]>();
  for (const event of ordered) {
    if (!TOOL_CALL_KINDS.has(event.kind)) continue;
    const tool = toolNameOf(event);
    const { detail } = splitName(event.name);
    if (!detail || CONTROL_TOOLS.has(tool) || /^[\s{}[\]()]*$/u.test(detail)) continue;
    const key = `${tool} · ${detail}`;
    const lanes = actionLanes.get(key) ?? new Set<string>();
    lanes.add(event.agentId ?? "system");
    actionLanes.set(key, lanes);
    actionEvents.set(key, [...(actionEvents.get(key) ?? []), event.id]);
  }
  const overlaps = [...actionLanes.entries()].filter(([, lanes]) => lanes.size > 1);
  if (overlaps.length > 0) {
    findings.push({
      id: "overlapping-lanes",
      severity: "medium",
      title: `${plural(overlaps.length, "action")} repeated in more than one lane`,
      detail: overlaps
        .slice(0, 3)
        .map(([key, lanes]) => `"${key}" in ${listNames([...lanes])}`)
        .join("; "),
      suggestion:
        "Partition the work in the prompt so lanes do not re-read the same material, or put the shared context into every assignment.",
      eventIds: overlaps.flatMap(([key]) => actionEvents.get(key) ?? []),
    });
  }

  // 6. Heavy assembly on the orchestrator after the last join.
  const lastJoinSeq = Math.max(
    0,
    ...ordered.filter((event) => event.kind === "agent_end").map(seqOf),
  );
  const postJoinTurns = rootTurns.filter((event) => seqOf(event) > lastJoinSeq);
  if (lastJoinSeq > 0 && postJoinTurns.length > POST_JOIN_TURNS_THRESHOLD) {
    findings.push({
      id: "post-join-assembly",
      severity: "info",
      title: `The orchestrator took ${plural(postJoinTurns.length, "turn")} after the last child joined`,
      detail:
        "Assembly and verification of the children's output happened inside the orchestrator's already-heavy context.",
      suggestion:
        "If the final assembly is substantial, ask for it as a delegated step (a writeup or verifier agent) so the orchestrator only joins results.",
      eventIds: postJoinTurns.map((event) => event.id),
    });
  }

  // 7. No delegation at all in a long single-context run.
  const rootCalls = rootLane.filter((event) => TOOL_CALL_KINDS.has(event.kind));
  const rootResults = rootLane.filter((event) => event.kind === "tool_result");
  if (spawns.length === 0 && rootCalls.length >= UNDELEGATED_CALLS_THRESHOLD) {
    findings.push({
      id: "no-delegation",
      severity: "info",
      title: `Everything ran in one context: ${plural(rootCalls.length, "tool call")}, ${plural(rootTurns.length, "turn")}, no subagent`,
      detail: `${plural(rootResults.length, "tool result")} landed in the main context. Where the reads were independent (different repos, directories or questions), a scout per area would have kept its results out of that context.`,
      suggestion:
        "If the task has independent parts, say so and ask for a subagent per part; the ledger above shows what each wave saves once it exists.",
      eventIds: rootCalls.map((event) => event.id),
    });
  }

  // 8. Positive confirmation when dispatch worked.
  if (spawns.length > 0 && poor.length === 0) {
    const net = spawns.reduce((sum, spawn) => sum + spawn.netTokens, 0);
    findings.push({
      id: "dispatch-paid-off",
      severity: "info",
      title: `Delegation paid off: ${plural(spawns.length, "wave")}, ${plural(optimization.independentTasks, "agent")}, net ≥${net} tokens kept out of the orchestrator`,
      detail: spawns.map((spawn) => `"${spawn.label}" +${spawn.netTokens}`).join(" · "),
      suggestion: "Keep asking for parallel subagents when the slices are this independent.",
      eventIds: spawns.map((spawn) => spawn.handoffEventId),
    });
  }

  return { promptEvent, promptPreview, promptTokens, findings };
}
