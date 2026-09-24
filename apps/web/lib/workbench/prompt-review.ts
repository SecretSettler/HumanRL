import { TOOL_CALL_KINDS, firstUserPrompt, splitName, toolNameOf } from "./execution-story";
import {
  accountSpawns,
  promptTokensOf,
  rootAgentOf,
  turnEvents,
  type SpawnAccounting,
} from "./spawn-accounting";
import { splitTurns } from "./prompt-turns";
import type { RawTraceEvent } from "./types";

/**
 * Prompt review: what each prompt caused, read back from the trace.
 *
 * A session is reviewed turn by turn: every message the author typed gets its
 * own findings, drawn from the events that message set off (see
 * `splitTurns`). A correction halfway through a session is judged on what it
 * caused, not blended into the opening prompt.
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
  /** Zero-based turn index; 0 for the opening prompt. */
  turnIndex: number;
  promptEvent: RawTraceEvent | null;
  promptPreview: string;
  promptTokens: number;
  findings: PromptFinding[];
}

/** Below this many model turns before the first spawn, the main agent did not have to invent the task. */
const PLANNING_TURNS_THRESHOLD = 3;
/** A prompt shorter than this rarely states deliverable, constraints and stop condition. */
const SHORT_PROMPT_TOKENS = 60;
/** More post-join turns than this means the main agent did the assembly itself. */
const POST_JOIN_TURNS_THRESHOLD = 8;
/** A prompt run with this many main-agent tool calls and no subagent is worth a note. */
const UNDELEGATED_CALLS_THRESHOLD = 20;
/** This many lookups in the main agent, with no subagent, is research worth handing out. */
const LOOKUP_THRESHOLD = 8;
/** Read-only lookups whose results a subagent could read and summarize instead. */
const LOOKUP_TOOLS: ReadonlySet<string> = new Set([
  "websearch",
  "webfetch",
  "web_search",
  "web_fetch",
  "fetch",
  "search",
  "read",
  "read_file",
  "grep",
  "glob",
  "ls",
  "list_files",
  "view",
]);
/** One batch taking more than this share of all subagent work dominates the run. */
const DOMINANT_WAVE_SHARE = 0.6;
/** Task assignments this many times larger than the prompt mean the main agent wrote the task. */
const INVENTED_TASK_RATIO = 3;
/** Control-flow tools whose "action" is not work that agents could be duplicating. */
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

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}

/** "15 WebFetch, 11 WebSearch": the most used tools among `calls`, most first. */
function toolBreakdown(calls: readonly RawTraceEvent[], limit = 3): string {
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(toolNameOf(call), (counts.get(toolNameOf(call)) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, limit).map(([tool, count]) => `${count} ${tool}`);
  const rest = sorted.slice(limit).reduce((sum, [, count]) => sum + count, 0);
  return rest > 0 ? `${shown.join(", ")}, ${rest} other` : shown.join(", ");
}

/** One review per author prompt, oldest first. Empty before the first prompt. */
export function reviewTurns(events: readonly RawTraceEvent[]): PromptReview[] {
  const spawns = accountSpawns(events);
  return splitTurns(events).map((turn) => {
    const ids = new Set(turn.events.map((event) => event.id));
    return reviewPrompt({
      events: turn.events,
      spawns: spawns.filter((spawn) => ids.has(spawn.handoffEventId)),
      turnIndex: turn.index,
    });
  });
}

/**
 * Review a single turn. `events` are the turn's events (its prompt comes
 * first among the author's messages); `spawns` are the subagent batches started in it.
 */
export function reviewPrompt({
  events,
  spawns,
  turnIndex = 0,
}: {
  events: readonly RawTraceEvent[];
  spawns: readonly SpawnAccounting[];
  turnIndex?: number;
}): PromptReview {
  const ordered = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  const rootAgentId = rootAgentOf(ordered);
  const promptEvent = firstUserPrompt(ordered);
  const promptPreview = promptEvent ? (splitName(promptEvent.name).detail ?? promptEvent.name) : "";
  const promptTokens = promptEvent ? promptTokensOf(promptEvent) : 0;
  const findings: PromptFinding[] = [];
  if (!promptEvent) return { turnIndex, promptEvent, promptPreview, promptTokens, findings };

  const rootLane = ordered.filter((event) => event.agentId === rootAgentId);
  const followUp = turnIndex > 0;
  const firstSpawnSeq = spawns[0]?.seq ?? Number.POSITIVE_INFINITY;

  // 1. Tools that were reached for but do not exist in the environment.
  const failedResults = ordered.filter(isFailedResult);
  const missing = failedResults.filter((event) =>
    /not found|unknown tool|not available/iu.test(event.name),
  );
  if (missing.length > 0) {
    const tools = [...new Set(missing.map(toolNameOf))];
    const agents = new Set(missing.map((event) => event.agentId ?? "system"));
    findings.push({
      id: "missing-tools",
      severity: "high",
      title: `Agents tried ${plural(tools.length, "tool")} that don't exist here: ${listNames(tools)}`,
      detail: `${plural(missing.length, "call")} failed with "not found" (${listNames([...agents])}). Each failure cost a step and a retry.`,
      suggestion:
        "Tell the agent which tools it has, or drop the part of the request that needs the missing ones (for example, checking results with code when nothing here can run code).",
      eventIds: missing.map((event) => event.id),
    });
  } else if (failedResults.length > 0) {
    const examples = failedResults
      .slice(0, 2)
      .map((event) => `${toolNameOf(event)}: ${(splitName(event.name).detail ?? "").slice(0, 80)}`);
    findings.push({
      id: "tool-failures",
      severity: "info",
      title: `${plural(failedResults.length, "tool call")} failed (${toolBreakdown(failedResults)})`,
      detail: examples.join(" · "),
      suggestion:
        "Open them to see whether the prompt asked for something this environment can't do; if so, say so up front.",
      eventIds: failedResults.map((event) => event.id),
    });
  }

  // 2. A short prompt the main agent had to turn into a task itself.
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
      title: `Your prompt was ~${promptTokens} tokens; the main agent then wrote ~${assignmentTokens} tokens of instructions for its subagents`,
      detail: `It spent ${plural(planningTurns.length, "step")} and ${plural(planningReads.length, "tool call")} working out the plan first. Open one of those instructions to see what it had to decide for you: what to deliver, how to split the work, when to stop.`,
      suggestion:
        "Put those decisions in the prompt yourself. The instructions it wrote are a good draft of the prompt you could have sent.",
      eventIds: [
        ...assignments.map((event) => event.id),
        ...planningTurns.map((event) => event.id),
      ],
    });
  } else if (
    // A short follow-up ("continue", "fix that") leans on the context already
    // built, so only the opening prompt is judged on its length alone.
    !followUp &&
    promptTokens < SHORT_PROMPT_TOKENS &&
    planningTurns.length >= PLANNING_TURNS_THRESHOLD
  ) {
    findings.push({
      id: "short-prompt",
      severity: "medium",
      title: `Your prompt was ~${promptTokens} tokens; the main agent spent ${plural(planningTurns.length, "step")} and ${plural(planningReads.length, "tool call")} working out what to do`,
      detail: "It had to decide the scope, what to deliver and when to stop by itself.",
      suggestion: "Say what you want delivered, any constraints, and when the job is done.",
      eventIds: planningTurns.map((event) => event.id),
    });
  }

  // 3. Research and long runs the main agent did alone.
  const rootCalls = rootLane.filter((event) => TOOL_CALL_KINDS.has(event.kind));
  const lookups = rootCalls.filter((event) => LOOKUP_TOOLS.has(toolNameOf(event).toLowerCase()));
  if (spawns.length === 0 && lookups.length >= LOOKUP_THRESHOLD) {
    findings.push({
      id: "lookups-in-main-agent",
      severity: "medium",
      title: `The main agent did ${plural(lookups.length, "lookup")} itself (${toolBreakdown(lookups)})`,
      detail: `Everything they returned stayed in its context for the rest of the session. ${plural(rootCalls.length, "tool call")} for this prompt in total, no subagent.`,
      suggestion:
        'If the lookups answer separate questions, ask for one subagent per question that brings back a short summary, for example "use one subagent per topic and report back in a paragraph each".',
      eventIds: lookups.map((event) => event.id),
    });
  } else if (spawns.length === 0 && rootCalls.length >= UNDELEGATED_CALLS_THRESHOLD) {
    findings.push({
      id: "long-solo-run",
      severity: "info",
      title: `The main agent made ${plural(rootCalls.length, "tool call")} on its own for this prompt (${toolBreakdown(rootCalls)})`,
      detail:
        "Everything they returned stayed in its context. That is fine when each step depends on the one before.",
      suggestion:
        "If some of them were independent checks or explorations, say so in the prompt; they can run as subagents in parallel and report back.",
      eventIds: rootCalls.map((event) => event.id),
    });
  }

  // 4. Subagent batches that did too little to be worth starting.
  const poor = spawns.filter(
    (spawn) => spawn.verdict === "wasteful" || spawn.verdict === "marginal",
  );
  if (poor.length > 0) {
    findings.push({
      id: "poor-spawns",
      severity: "medium",
      title: `${plural(poor.length, "batch", "batches")} of subagents did too little to be worth starting`,
      detail: poor
        .map(
          (spawn) =>
            `"${spawn.label}": ${plural(spawn.childAgentIds.length, "subagent")}, ${plural(spawn.childToolCalls, "tool call")} between them.`,
        )
        .join(" "),
      suggestion:
        "Ask for subagents only for pieces that are independent and sizeable; small or step-by-step work is cheaper in the main agent.",
      eventIds: poor.map((spawn) => spawn.handoffEventId),
    });
  }

  // 5. One batch doing most of the subagent work: is that what the prompt was for?
  const absorbedTotal = spawns.reduce((sum, spawn) => sum + spawn.absorbedTokens, 0);
  const dominant: SpawnAccounting | undefined = spawns.find(
    (spawn) => absorbedTotal > 0 && spawn.absorbedTokens / absorbedTotal >= DOMINANT_WAVE_SHARE,
  );
  if (dominant && spawns.length > 1) {
    const share = Math.round((dominant.absorbedTokens / absorbedTotal) * 100);
    findings.push({
      id: "dominant-wave",
      severity: "info",
      title: `${share}% of the subagent work went to "${dominant.label}"`,
      detail: `${listNames(dominant.childAgentIds)} did most of the work across ${plural(spawns.length, "batch", "batches")} of subagents.`,
      suggestion:
        "If that was a side task rather than what you asked for, run it as a separate prompt so the main task gets the attention.",
      eventIds: [dominant.handoffEventId],
    });
  }

  // 6. Same action repeated by several agents: overlapping assignments.
  const actionAgents = new Map<string, Set<string>>();
  const actionEvents = new Map<string, string[]>();
  for (const event of ordered) {
    if (!TOOL_CALL_KINDS.has(event.kind)) continue;
    const tool = toolNameOf(event);
    const { detail } = splitName(event.name);
    if (!detail || CONTROL_TOOLS.has(tool) || /^[\s{}[\]()]*$/u.test(detail)) continue;
    const key = `${tool} · ${detail}`;
    const agents = actionAgents.get(key) ?? new Set<string>();
    agents.add(event.agentId ?? "system");
    actionAgents.set(key, agents);
    actionEvents.set(key, [...(actionEvents.get(key) ?? []), event.id]);
  }
  const overlaps = [...actionAgents.entries()].filter(([, agents]) => agents.size > 1);
  if (overlaps.length > 0) {
    findings.push({
      id: "overlapping-lanes",
      severity: "medium",
      title: `${plural(overlaps.length, "action")} ${overlaps.length === 1 ? "was" : "were"} repeated by more than one agent`,
      detail: overlaps
        .slice(0, 3)
        .map(([key, agents]) => `"${key}" by ${listNames([...agents])}`)
        .join("; "),
      suggestion:
        "Split the work in the prompt so agents don't read the same material twice, or give every agent the shared background up front.",
      eventIds: overlaps.flatMap(([key]) => actionEvents.get(key) ?? []),
    });
  }

  // 7. Heavy assembly in the main agent after the last subagent finished.
  const lastJoinSeq = Math.max(
    0,
    ...ordered.filter((event) => event.kind === "agent_end").map(seqOf),
  );
  const postJoinTurns = rootTurns.filter((event) => seqOf(event) > lastJoinSeq);
  if (lastJoinSeq > 0 && postJoinTurns.length > POST_JOIN_TURNS_THRESHOLD) {
    findings.push({
      id: "post-join-assembly",
      severity: "info",
      title: `The main agent took ${plural(postJoinTurns.length, "more step")} after its subagents finished`,
      detail:
        "It put the results together and checked them itself, on top of everything already in its context.",
      suggestion:
        "If combining the results is a big job, ask for it as its own step (for example a subagent that writes the final report), so the main agent only collects results.",
      eventIds: postJoinTurns.map((event) => event.id),
    });
  }

  // 8. Positive confirmation when subagents worked.
  if (spawns.length > 0 && poor.length === 0) {
    const children = new Set(spawns.flatMap((spawn) => spawn.childAgentIds)).size;
    const childCalls = spawns.reduce((sum, spawn) => sum + spawn.childToolCalls, 0);
    findings.push({
      id: "dispatch-paid-off",
      severity: "info",
      title: `Subagents helped: ${plural(children, "subagent")} made ${plural(childCalls, "tool call")} outside the main agent's context`,
      detail: spawns
        .map((spawn) => `"${spawn.label}": ${plural(spawn.childToolCalls, "tool call")}`)
        .join(" · "),
      suggestion: "Keep asking for subagents when the pieces are this independent.",
      eventIds: spawns.map((spawn) => spawn.handoffEventId),
    });
  }

  return { turnIndex, promptEvent, promptPreview, promptTokens, findings };
}
