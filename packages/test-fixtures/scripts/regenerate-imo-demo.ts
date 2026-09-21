import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  RawTraceEventInputSchema,
  SchemaVersion,
  type RawEventKind,
  type RawTraceEventInput,
} from "@intenttrace/schema";

const CHILDREN = [
  "ImoBruteForce",
  "ImoConstructions",
  "ImoImpossibility",
  "ImoVerifier",
  "ImoWriteup",
  "WebUiSurface",
  "IngestAndFixtures",
  "DocsConventions",
] as const;
type ChildName = (typeof CHILDREN)[number];

const ROLES: Record<ChildName, string> = {
  ImoBruteForce: "exhaustive small-case search",
  ImoConstructions: "constructions for k=0,1,3",
  ImoImpossibility: "impossibility proof",
  ImoVerifier: "adversarial audit",
  ImoWriteup: "final joined solution",
  WebUiSurface: "web and workbench surface research",
  IngestAndFixtures: "ingestion and fixture research",
  DocsConventions: "documentation conventions research",
};

const MAIN_AGENT = "Orchestrator";
const FORMAT_VERSION = "1.0.0";
const ADAPTER_VERSION = "1.0.0";
const SOURCE_INSTANCE_ID = "imo-2025-p1-parallel-solve-topology-v2";
const TRACE_TITLE = "IMO 2025 P1 solved by eight parallel agents";
const ROOT_START = "2026-08-12T14:15:39.264Z";
const NAME_LIMIT = 240;
const PREVIEW_LIMIT = 190;
const PAYLOAD_LIMIT = 1_800;
const TOOL_PAYLOAD_LIMIT = 1_200;
const OUTPUT_PATH = new URL("../fixtures/demo/imo-2025-p1-parallel-solve.jsonl", import.meta.url);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const HOME_PATH_PATTERN = /(?:\/home\/[^/\s"']+|\/Users\/[^/\s"']+|[A-Z]:\\Users\\[^\\\s"']+)/gu;
const SECRET_PATTERN =
  /(\b(?:api[_-]?key|authorization|password|secret)\b\s*[:=]\s*)([^\s,;}"]+)/giu;
const TOOL_KINDS: Record<string, RawEventKind> = {
  read: "file_read",
  glob: "file_read",
  grep: "file_read",
  write: "file_write",
  bash: "shell_command",
};

interface TranscriptRecord {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  model?: string;
  customType?: string;
  data?: Record<string, unknown>;
  message?: Record<string, unknown>;
  systemPrompt?: unknown;
}

interface RecordedEvent {
  occurredAt: string;
  lane: string;
  kind: RawEventKind;
  name: string;
  status: "unset" | "ok" | "error";
  spanId?: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
  payload?: unknown;
  sourceOrder: number;
}

interface DispatchFact {
  event: RecordedEvent;
  children: ChildName[];
  toolCallId: string;
}

function usage(): never {
  throw new Error(
    "Usage: pnpm --filter @intenttrace/test-fixtures regenerate:imo-demo -- <session-root>",
  );
}

function stableUuid(label: string): string {
  const bytes = createHash("sha256")
    .update(`intenttrace-imo-topology-v2:${label}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sanitizeText(value: string, limit: number): string {
  const normalized = value
    .replace(HOME_PATH_PATTERN, "~")
    .replace(SECRET_PATTERN, "$1[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[nested content omitted]";
  if (typeof value === "string") return sanitizeText(value, TOOL_PAYLOAD_LIMIT);
  if (Array.isArray(value))
    return value.slice(0, 32).map((item) => sanitizeUnknown(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input).slice(0, 64)) {
    if (
      /^(?:thinking|thinkingSignature|signature|reasoning|systemPrompt)$/iu.test(key) ||
      /^(?:encrypted_content|redacted_thinking)$/u.test(key)
    ) {
      continue;
    }
    output[key] = sanitizeUnknown(item, depth + 1);
  }
  return output;
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function readJsonLines(path: string): TranscriptRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as TranscriptRecord;
      } catch (error) {
        throw new Error(`${basename(path)}:${index + 1}: invalid JSON`, { cause: error });
      }
    });
}

function textParts(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter(
      (part): part is Record<string, unknown> =>
        part !== null &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text as string)
    .join(" ");
}

function toolCallCount(message: Record<string, unknown>): number {
  return Array.isArray(message.content)
    ? message.content.filter(
        (part) =>
          part !== null &&
          typeof part === "object" &&
          (part as Record<string, unknown>).type === "toolCall",
      ).length
    : 0;
}

function omittedReasoningCount(message: Record<string, unknown>): number {
  return Array.isArray(message.content)
    ? message.content.filter(
        (part) =>
          part !== null &&
          typeof part === "object" &&
          ["thinking", "redacted_thinking", "reasoning"].includes(
            String((part as Record<string, unknown>).type),
          ),
      ).length
    : 0;
}

function eventName(label: string, body: string): string {
  const preview = sanitizeText(body, PREVIEW_LIMIT);
  return sanitizeText(preview.length > 0 ? `${label} · ${preview}` : label, NAME_LIMIT);
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

function makeBaseEvent(
  lane: string,
  kind: RawEventKind,
  timestamp: string,
  name: string,
  sourceOrder: number,
  record: TranscriptRecord,
  attributes: Record<string, unknown> = {},
  payload?: unknown,
): RecordedEvent {
  return {
    occurredAt: normalizeTimestamp(timestamp),
    lane,
    kind,
    name,
    status: "ok",
    ...(id(record.id) ? { spanId: id(record.id) } : {}),
    attributes,
    ...(payload === undefined ? {} : { payload: sanitizeUnknown(payload) }),
    sourceOrder,
  };
}

function parseTaskChildren(data: Record<string, unknown>): ChildName[] {
  const intent = typeof data.intent === "string" ? data.intent.toLowerCase() : "";
  if (intent.includes("real parallel imo solve")) {
    return ["ImoBruteForce", "ImoConstructions", "ImoImpossibility"];
  }
  if (intent.includes("ui, ingest, docs conventions")) {
    return ["WebUiSurface", "IngestAndFixtures", "DocsConventions"];
  }
  if (intent.includes("verification") || intent.includes("verifier")) {
    return ["ImoVerifier", "ImoWriteup"];
  }
  return [];
}

function convertTranscript(
  lane: string,
  records: readonly TranscriptRecord[],
  root: boolean,
): { events: RecordedEvent[]; dispatches: DispatchFact[] } {
  const events: RecordedEvent[] = [];
  const dispatches: DispatchFact[] = [];
  let model = "model";
  for (const [sourceOrder, record] of records.entries()) {
    if (!record.timestamp || (root && record.timestamp < ROOT_START)) continue;
    if (record.type === "model_change" && typeof record.model === "string") {
      model = record.model;
      if (!root) {
        events.push(
          makeBaseEvent(
            lane,
            "log",
            record.timestamp,
            eventName("Agent config", `model ${model}`),
            sourceOrder,
            record,
            { model },
          ),
        );
      }
      continue;
    }
    if (record.type === "session") {
      if (!root) {
        events.push(
          makeBaseEvent(
            lane,
            "agent_start",
            record.timestamp,
            eventName("Agent start", `${lane} — ${ROLES[lane as ChildName]}`),
            sourceOrder,
            record,
            { parentAgentId: MAIN_AGENT, role: ROLES[lane as ChildName], assignedBy: MAIN_AGENT },
          ),
        );
      }
      continue;
    }
    if (record.type === "custom" && record.customType === "tool_execution_start" && record.data) {
      const tool = String(record.data.toolName ?? "tool");
      const intent = typeof record.data.intent === "string" ? record.data.intent : "";
      const toolCallId = String(record.data.toolCallId ?? record.id ?? `${lane}-${sourceOrder}`);
      const children = root && tool === "task" ? parseTaskChildren(record.data) : [];
      const kind: RawEventKind =
        children.length > 0 ? "agent_handoff" : (TOOL_KINDS[tool] ?? "tool_call");
      const label = children.length > 0 ? "Handoff: dispatch subagents" : `Tool call: ${tool}`;
      const args = sanitizeUnknown(record.data.args ?? {});
      const event = makeBaseEvent(
        lane,
        kind,
        typeof record.data.startedAt === "string" ? record.data.startedAt : record.timestamp,
        eventName(label, intent || JSON.stringify(args)),
        sourceOrder,
        record,
        {
          tool,
          ...(children.length > 0 ? { spawnedAgentIds: children } : {}),
          ...(!root && kind === "file_write" ? { onBehalfOf: lane, assignedBy: MAIN_AGENT } : {}),
        },
        { tool, args },
      );
      if (children.length > 0) {
        event.spanId = id(toolCallId) ?? event.spanId;
        dispatches.push({ event, children, toolCallId: event.spanId ?? toolCallId });
      }
      events.push(event);
      continue;
    }
    if (record.type !== "message" || !record.message) continue;
    const message = record.message;
    const role = message.role;
    if (role === "assistant") {
      const body = textParts(message);
      const calls = toolCallCount(message);
      const omitted = omittedReasoningCount(message);
      events.push(
        makeBaseEvent(
          lane,
          "model_call",
          record.timestamp,
          eventName("Model call", `${model} · ${calls} tool call(s)${body ? " + text" : ""}`),
          sourceOrder,
          record,
          { model, toolCalls: calls, ...(omitted > 0 ? { reasoningBlocksOmitted: omitted } : {}) },
        ),
      );
      if (body) {
        events.push(
          makeBaseEvent(
            lane,
            "assistant_message",
            record.timestamp,
            eventName("Assistant", body),
            sourceOrder + 0.1,
            record,
            omitted > 0 ? { reasoningBlocksOmitted: omitted } : {},
            { text: sanitizeText(body, PAYLOAD_LIMIT) },
          ),
        );
      }
      continue;
    }
    if (role === "user") {
      const body = textParts(message);
      if (body) {
        events.push(
          makeBaseEvent(
            lane,
            "user_message",
            record.timestamp,
            eventName(root ? "User request" : "Task assignment", body),
            sourceOrder,
            record,
            root ? {} : { assignedBy: MAIN_AGENT },
            { text: sanitizeText(body, PAYLOAD_LIMIT) },
          ),
        );
      }
      continue;
    }
    if (role === "toolResult") {
      const tool = String(message.toolName ?? "tool");
      const body = textParts(message);
      const status = message.isError === true ? "error" : "ok";
      const event = makeBaseEvent(
        lane,
        "tool_result",
        record.timestamp,
        eventName(`Tool result: ${tool}`, body || "(no text)"),
        sourceOrder,
        record,
        { tool, ...(status === "error" ? { failed: true } : {}) },
        { tool, result: sanitizeText(body, TOOL_PAYLOAD_LIMIT) },
      );
      event.status = status;
      events.push(event);
    }
  }
  return { events, dispatches };
}

function chooseDispatch(dispatches: readonly DispatchFact[], child: ChildName): DispatchFact {
  const dispatch = dispatches.find((candidate) => candidate.children.includes(child));
  if (!dispatch) throw new Error(`No executed task dispatch names required child ${child}`);
  return dispatch;
}

function main(): void {
  const cliArguments = process.argv.slice(2).filter((value) => value !== "--");
  const argument = cliArguments[0];
  if (!argument || cliArguments.length !== 1) usage();
  const sessionRoot = resolve(argument);
  const rootTranscript = `${sessionRoot}.jsonl`;
  const required = [
    { relative: `${basename(sessionRoot)}.jsonl`, path: rootTranscript },
    ...CHILDREN.map((child) => ({
      relative: `${child}.jsonl`,
      path: join(sessionRoot, `${child}.jsonl`),
    })),
  ];
  const missing = required
    .filter((entry) => !existsSync(entry.path))
    .map((entry) => entry.relative);
  if (missing.length > 0) {
    throw new Error(
      `Missing required session inputs:\n${missing.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  const root = convertTranscript(MAIN_AGENT, readJsonLines(rootTranscript), true);
  const events = [...root.events];
  for (const child of CHILDREN) {
    const converted = convertTranscript(
      child,
      readJsonLines(join(sessionRoot, `${child}.jsonl`)),
      false,
    );
    const dispatch = chooseDispatch(root.dispatches, child);
    const start = converted.events.find((event) => event.kind === "agent_start");
    if (!start) throw new Error(`${child}.jsonl does not contain a convertible session start`);
    start.parentSpanId = dispatch.toolCallId;
    start.attributes.parentAgentId = MAIN_AGENT;
    start.attributes.assignedBy = MAIN_AGENT;
    const endTime = converted.events.at(-1)?.occurredAt;
    if (!endTime) throw new Error(`${child}.jsonl does not contain convertible events`);
    converted.events.push({
      occurredAt: endTime,
      lane: child,
      kind: "agent_end",
      name: eventName("Agent end", `${child} joined by ${MAIN_AGENT}`),
      status: "ok",
      attributes: { joinedBy: MAIN_AGENT },
      sourceOrder: Number.MAX_SAFE_INTEGER,
    });
    events.push(...converted.events);
  }

  for (const dispatch of root.dispatches) {
    const joinedAgentIds = dispatch.children;
    events.push({
      occurredAt: new Date(
        Math.max(
          ...joinedAgentIds.map((child) =>
            Date.parse(
              events
                .filter((event) => event.lane === child)
                .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
                .at(-1)!.occurredAt,
            ),
          ),
        ) + 1,
      ).toISOString(),
      lane: MAIN_AGENT,
      kind: "tool_result",
      name: eventName("Joined subagents", joinedAgentIds.join(", ")),
      status: "ok",
      attributes: { joinedAgentIds },
      sourceOrder: dispatch.event.sourceOrder + 0.9,
    });
  }

  events.sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.sourceOrder - right.sourceOrder ||
      left.lane.localeCompare(right.lane) ||
      left.kind.localeCompare(right.kind),
  );

  const traceId = stableUuid("trace-topology-v2");
  const workspaceId = stableUuid("workspace");
  const projectId = stableUuid("project");
  const output: RawTraceEventInput[] = events.map((event, index) =>
    RawTraceEventInputSchema.parse({
      schemaVersion: SchemaVersion,
      workspaceId,
      projectId,
      traceId,
      workspaceName: "IntentTrace demo",
      projectName: "Parallel agent math solve",
      traceTitle: TRACE_TITLE,
      source: {
        kind: "jsonl",
        formatVersion: FORMAT_VERSION,
        adapterVersion: ADAPTER_VERSION,
        sourceInstanceId: SOURCE_INSTANCE_ID,
        sourceEventId: `${event.lane}-${String(index + 1).padStart(4, "0")}`,
      },
      occurredAt: event.occurredAt,
      kind: event.kind,
      name: event.name,
      status: event.status,
      agentId: event.lane,
      ...(event.spanId ? { spanId: event.spanId } : {}),
      ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
      artifactRefs: [],
      attributes: { run: SOURCE_INSTANCE_ID, ...event.attributes },
      ...(event.payload === undefined ? {} : { payload: event.payload }),
    }),
  );
  const lastTimestamp = output.at(-1)?.occurredAt;
  if (!lastTimestamp) throw new Error("Recorder produced no events");
  output.push(
    RawTraceEventInputSchema.parse({
      schemaVersion: SchemaVersion,
      workspaceId,
      projectId,
      traceId,
      workspaceName: "IntentTrace demo",
      projectName: "Parallel agent math solve",
      traceTitle: TRACE_TITLE,
      source: {
        kind: "jsonl",
        formatVersion: FORMAT_VERSION,
        adapterVersion: ADAPTER_VERSION,
        sourceInstanceId: SOURCE_INSTANCE_ID,
        sourceEventId: `trace-complete-${String(output.length + 1).padStart(4, "0")}`,
      },
      occurredAt: lastTimestamp,
      kind: "trace_complete",
      name: "Trace complete · answer k ∈ {0, 1, 3}; eight child lanes joined by the orchestrator",
      status: "ok",
      agentId: MAIN_AGENT,
      artifactRefs: [],
      attributes: {
        run: SOURCE_INSTANCE_ID,
        answer: "k in {0,1,3}",
        agents: [MAIN_AGENT, ...CHILDREN],
        machineChecked: "exhaustive cover search n=3..6; three line families verified n=3..8",
        reasoningPolicy: "hidden reasoning blocks omitted at record time",
      },
    }),
  );

  const blob = `${output.map((event) => JSON.stringify(event)).join("\n")}\n`;
  if (/(?:\/home\/|\/Users\/|[A-Z]:\\)/u.test(blob))
    throw new Error("Sanitization left a host path");
  if (/"(?:thinking|thinkingSignature|signature|reasoning|systemPrompt)"\s*:/u.test(blob)) {
    throw new Error("Sanitization left hidden reasoning or prompt fields");
  }
  const temporaryPath = join(dirname(OUTPUT_PATH.pathname), `.imo-demo-${process.pid}.tmp`);
  writeFileSync(temporaryPath, blob, "utf8");
  renameSync(temporaryPath, OUTPUT_PATH);
  const lanes = new Set(output.map((event) => event.agentId).filter(Boolean)).size;
  const spawns = output.filter((event) => event.kind === "agent_start").length;
  const joins = new Set(
    output
      .filter((event) => Array.isArray(event.attributes.joinedAgentIds))
      .flatMap((event) => event.attributes.joinedAgentIds as string[]),
  ).size;
  process.stdout.write(
    `Regenerated demo: ${output.length} events, ${lanes} lanes, ${spawns} spawns, ${joins} joins.\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
