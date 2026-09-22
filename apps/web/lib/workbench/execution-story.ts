import type { RawTraceEvent } from "./types";

/**
 * Execution story: a readable, lane-aware digest of the raw events.
 *
 * Everything here is derived from event metadata only (kind, name, status,
 * agentId, attributes). Payload bodies stay in the ArtifactStore and are never
 * needed to build the story, so this works on the withheld-by-default view.
 */

export const TOOL_CALL_KINDS: ReadonlySet<string> = new Set([
  "tool_call",
  "file_read",
  "file_write",
  "shell_command",
  "test_run",
]);

export type StoryCallStatus = "completed" | "failed" | "running";

export interface StoryCall {
  event: RawTraceEvent;
  result: RawTraceEvent | null;
  tool: string;
  action: string;
  status: StoryCallStatus;
}

export interface ToolStep {
  kind: "tools";
  id: string;
  agentId: string;
  seq: number;
  occurredAt: string;
  tool: string;
  calls: StoryCall[];
}

export interface SpawnStep {
  kind: "spawn";
  id: string;
  agentId: string;
  seq: number;
  occurredAt: string;
  event: RawTraceEvent;
  label: string;
  childAgentIds: string[];
}

export interface JoinStep {
  kind: "join";
  id: string;
  agentId: string;
  seq: number;
  occurredAt: string;
  event: RawTraceEvent;
  joinedBy: string | null;
}

export interface MessageStep {
  kind: "message";
  id: string;
  agentId: string;
  seq: number;
  occurredAt: string;
  event: RawTraceEvent;
  role: "user" | "assistant";
  label: string;
  text: string;
}

export type StoryStep = ToolStep | SpawnStep | JoinStep | MessageStep;

function seqOf(event: RawTraceEvent): number {
  return Number(event.ingestSeq);
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

/**
 * Adapters write names as `<Label>: <tool> · <human description>` (Codex,
 * Claude and the canonical JSONL demo all follow it). Split on the first
 * middle dot so the UI can show "read · Reading plan-writing skill" instead of
 * the raw kind.
 */
export function splitName(name: string): { head: string; detail: string | null } {
  const index = name.indexOf(" · ");
  if (index < 0) return { head: name.trim(), detail: null };
  return { head: name.slice(0, index).trim(), detail: name.slice(index + 3).trim() || null };
}

export function toolNameOf(event: RawTraceEvent): string {
  const explicit = stringAttr(event, "tool") ?? stringAttr(event, "toolName");
  if (explicit) return explicit;
  const { head } = splitName(event.name);
  const afterColon = head.includes(":") ? head.slice(head.indexOf(":") + 1).trim() : "";
  if (afterColon) return afterColon;
  return KIND_TOOL[event.kind] ?? event.kind;
}

const KIND_TOOL: Record<string, string> = {
  file_read: "read",
  file_write: "write",
  shell_command: "bash",
  test_run: "test",
};

const KIND_FALLBACK: Record<string, string> = {
  file_read: "Read a file",
  file_write: "Wrote a file",
  shell_command: "Ran a command",
  test_run: "Ran tests",
  tool_call: "Called a tool",
};

/**
 * Messages the harness injects around the conversation (AGENTS.md, environment
 * context, skill catalogues, role preambles) are not the author's prompt and
 * not the agent's narration. Codex tags them as user or assistant messages, so
 * they are recognised by shape.
 */
export function isHarnessMessage(text: string): boolean {
  return /^\s*(?:<[a-z_]+[^>]*>|#\s*AGENTS\.md|<INSTRUCTIONS>)/iu.test(text);
}

/** The author's prompt: the first user message that is neither a task assignment nor harness-injected. */
export function firstUserPrompt(events: readonly RawTraceEvent[]): RawTraceEvent | null {
  return (
    [...events]
      .sort((a, b) => seqOf(a) - seqOf(b))
      .find(
        (event) =>
          event.kind === "user_message" &&
          !stringAttr(event, "assignedBy") &&
          !isHarnessMessage(splitName(event.name).detail ?? event.name),
      ) ?? null
  );
}

/**
 * Codex records an exec call as the JavaScript it ran; the commands inside
 * (`cmd:"…"`) are the readable part. Anything else is shown as written.
 */
export function summarizeAction(detail: string): string {
  // The name is capped at 240 characters, so the last command may be cut off
  // before its closing quote; take it to the end of the text in that case.
  const commands = [...detail.matchAll(/cmd:\s*"((?:[^"\\]|\\.)*)(?:"|$)/gu)].map((match) =>
    match[1]!.replace(/\\"/gu, '"').replace(/\\n/gu, " ").trim(),
  );
  if (commands.length === 0) return detail.replace(/\s+/gu, " ").trim();
  const first = commands[0]!;
  return commands.length > 1 ? `${first}  (+${commands.length - 1} more)` : first;
}

export function describeToolCall(event: RawTraceEvent): { tool: string; action: string } {
  const tool = toolNameOf(event);
  const { detail } = splitName(event.name);
  return {
    tool,
    action: detail ? summarizeAction(detail) : (KIND_FALLBACK[event.kind] ?? event.name),
  };
}

function callStatus(call: RawTraceEvent, result: RawTraceEvent | null): StoryCallStatus {
  if (call.status === "error") return "failed";
  if (result) {
    if (result.status === "error" || result.attributes.failed === true) return "failed";
    return "completed";
  }
  return "running";
}

/**
 * Pair every tool call with its result. Canonical events carry no
 * causationEventId, so results are matched FIFO inside the same agent lane
 * and the same tool name; an explicit causation link wins when present.
 */
export function pairToolResults(
  events: readonly RawTraceEvent[],
): Map<string, RawTraceEvent | null> {
  const ordered = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  const byId = new Map(ordered.map((event) => [event.id, event] as const));
  const pending = new Map<string, RawTraceEvent[]>();
  const paired = new Map<string, RawTraceEvent | null>();

  const queueKey = (event: RawTraceEvent) => `${event.agentId ?? ""}\u0000${toolNameOf(event)}`;

  for (const event of ordered) {
    if (TOOL_CALL_KINDS.has(event.kind)) {
      paired.set(event.id, null);
      const key = queueKey(event);
      const queue = pending.get(key) ?? [];
      queue.push(event);
      pending.set(key, queue);
      continue;
    }
    if (event.kind !== "tool_result") continue;

    const causation = event.causationEventId ? byId.get(event.causationEventId) : undefined;
    if (causation && paired.has(causation.id) && paired.get(causation.id) === null) {
      paired.set(causation.id, event);
      const queue = pending.get(queueKey(causation));
      if (queue) {
        const index = queue.indexOf(causation);
        if (index >= 0) queue.splice(index, 1);
      }
      continue;
    }
    const queue = pending.get(queueKey(event));
    const call = queue?.shift();
    if (call) paired.set(call.id, event);
  }
  return paired;
}

/**
 * Collapse the raw stream into steps. Consecutive calls of the same tool by
 * the same agent become one step (a scout reading twelve files is one line,
 * not twelve); spawns, joins and the user's messages stay as their own steps.
 */
export function buildExecutionStory(events: readonly RawTraceEvent[]): StoryStep[] {
  const ordered = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  const results = pairToolResults(ordered);
  const steps: StoryStep[] = [];
  const openTools = new Map<string, ToolStep>();

  for (const event of ordered) {
    const agentId = event.agentId ?? "system";
    const seq = seqOf(event);

    if (TOOL_CALL_KINDS.has(event.kind)) {
      const { tool, action } = describeToolCall(event);
      const result = results.get(event.id) ?? null;
      const call: StoryCall = { event, result, tool, action, status: callStatus(event, result) };
      const open = openTools.get(agentId);
      if (open && open.tool === tool) {
        open.calls.push(call);
      } else {
        const step: ToolStep = {
          kind: "tools",
          id: event.id,
          agentId,
          seq,
          occurredAt: event.occurredAt,
          tool,
          calls: [call],
        };
        openTools.set(agentId, step);
        steps.push(step);
      }
      continue;
    }

    if (event.kind === "agent_handoff") {
      openTools.delete(agentId);
      const { detail } = splitName(event.name);
      steps.push({
        kind: "spawn",
        id: event.id,
        agentId,
        seq,
        occurredAt: event.occurredAt,
        event,
        label: detail ?? event.name,
        childAgentIds: stringListAttr(event, "spawnedAgentIds"),
      });
      continue;
    }

    if (event.kind === "agent_end") {
      openTools.delete(agentId);
      steps.push({
        kind: "join",
        id: event.id,
        agentId,
        seq,
        occurredAt: event.occurredAt,
        event,
        joinedBy: stringAttr(event, "joinedBy"),
      });
      continue;
    }

    if (event.kind === "user_message" || event.kind === "assistant_message") {
      const { head, detail } = splitName(event.name);
      const text = detail ?? event.name;
      if (isHarnessMessage(text)) continue;
      const role = event.kind === "user_message" ? "user" : "assistant";
      if (role === "user" && stringAttr(event, "assignedBy")) continue;
      // A message between two calls of the same tool starts a new step: the
      // agent said something, so the second run has a different reason.
      openTools.delete(agentId);
      steps.push({
        kind: "message",
        id: event.id,
        agentId,
        seq,
        occurredAt: event.occurredAt,
        event,
        role,
        label: head,
        text,
      });
      continue;
    }
    // Model calls, tool results and logs do not break a tool run; only a
    // different tool, a message or a lane event does.
  }
  return steps;
}

export interface StoryTotals {
  toolCalls: number;
  failed: number;
  running: number;
  spawns: number;
  spawnedAgents: number;
}

export function storyTotals(steps: readonly StoryStep[]): StoryTotals {
  const totals: StoryTotals = { toolCalls: 0, failed: 0, running: 0, spawns: 0, spawnedAgents: 0 };
  for (const step of steps) {
    if (step.kind === "tools") {
      totals.toolCalls += step.calls.length;
      for (const call of step.calls) {
        if (call.status === "failed") totals.failed += 1;
        if (call.status === "running") totals.running += 1;
      }
    } else if (step.kind === "spawn") {
      totals.spawns += 1;
      totals.spawnedAgents += step.childAgentIds.length;
    }
  }
  return totals;
}
