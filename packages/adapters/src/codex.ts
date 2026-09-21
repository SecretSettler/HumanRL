import { createHash } from "node:crypto";
import type { RawEventKind } from "@intenttrace/schema";

import {
  decodeAdapterBytes,
  displayName,
  displayPreview,
  normalizeEvent,
  objectRecord,
  readSessionRecords,
  sanitizeVendorValue,
  type SessionRecord,
} from "./common.js";
import {
  MalformedAdapterInputError,
  normalizeAdapterInput,
  singleAdapterPart,
  UnsupportedAdapterVersionError,
  type AdapterInput,
  type AdapterManifest,
  type AdapterRecord,
  type TraceAdapter,
} from "./types.js";
import { lookupTopologyCapability } from "./topology.js";

const supportedRecordTypes = new Set([
  "session_meta",
  "turn_context",
  "event_msg",
  "response_item",
]);
const sensitivePayloadTypes = new Set(["reasoning", "agent_reasoning", "reasoning_raw_content"]);

function codexKind(type: string, payload: Record<string, unknown> | null): RawEventKind {
  if (type === "session_meta") return "agent_start";
  if (type === "turn_context") return "log";
  if (type === "event_msg") {
    if (payload?.type === "user_message") return "user_message";
    if (payload?.type === "agent_message") return "assistant_message";
    if (payload?.type === "sub_agent_activity") return "agent_start";
    return "log";
  }
  if (type === "response_item") {
    const itemType = String(payload?.type ?? "");
    if (/function_call_output|tool_call_output|tool_result/iu.test(itemType)) return "tool_result";
    if (/function_call|tool_call/iu.test(itemType)) return "tool_call";
    if (/message/iu.test(itemType))
      return payload?.role === "user" ? "user_message" : "assistant_message";
  }
  return "log";
}

function codexDisplay(
  recordType: string,
  payload: Record<string, unknown> | null,
  toolNames: ReadonlyMap<string, string>,
): { name: string; toolName?: string; contentType: string } {
  const payloadType = String(payload?.type ?? "");
  if (recordType === "session_meta")
    return {
      name: displayName("Codex session started", payload?.model ?? payload?.model_provider),
      contentType: "session",
    };
  if (recordType === "turn_context") return { name: "Turn context", contentType: "context" };
  if (recordType === "response_item") {
    if (payloadType === "message" || payloadType === "agent_message") {
      const role = String(payload?.role ?? (payloadType === "agent_message" ? "agent" : "message"));
      return {
        name: displayName(
          role === "user" ? "User" : role === "agent" ? "Agent" : "Assistant",
          payload?.content,
        ),
        contentType: role === "user" ? "user_message" : "assistant_message",
      };
    }
    if (/function_call_output|tool_call_output|tool_result/iu.test(payloadType)) {
      const callId = String(payload?.call_id ?? "");
      const toolName = toolNames.get(callId);
      return {
        name: displayName(toolName ? `Tool result: ${toolName}` : "Tool result", payload?.output),
        ...(toolName ? { toolName } : {}),
        contentType: "tool_result",
      };
    }
    if (/function_call|tool_call/iu.test(payloadType)) {
      const toolName = String(payload?.name ?? payload?.namespace ?? "tool");
      return {
        name: displayName(`Tool call: ${toolName}`, payload?.input ?? payload?.arguments),
        toolName,
        contentType: "tool_call",
      };
    }
  }
  if (recordType === "event_msg") {
    if (payloadType === "user_message")
      return { name: displayName("User", payload?.message), contentType: "user_message" };
    if (payloadType === "agent_message")
      return { name: displayName("Agent", payload?.message), contentType: "assistant_message" };
    if (payloadType === "task_started") return { name: "Task started", contentType: "lifecycle" };
    if (payloadType === "task_complete")
      return {
        name: displayName("Task completed", payload?.last_agent_message),
        contentType: "lifecycle",
      };
    if (payloadType === "sub_agent_activity")
      return {
        name: displayName(`Sub-agent ${String(payload?.kind ?? "activity")}`, payload?.agent_path),
        contentType: "agent_activity",
      };
    if (payloadType === "error")
      return {
        name: displayName("Error", payload?.message ?? payload?.error),
        contentType: "error",
      };
  }
  return { name: displayName(payloadType || recordType, payload), contentType: "metadata" };
}

interface CodexPart {
  path: string;
  records: SessionRecord[];
  lane: string;
  root: string;
  forkedFrom: string | null;
  parent: string | null;
  historyMode: string;
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function messageText(payload: Record<string, unknown>): string {
  return Array.isArray(payload.content)
    ? payload.content
        .map((item) =>
          String(objectRecord(item)?.text ?? objectRecord(item)?.encrypted_content ?? ""),
        )
        .join("\n")
    : "";
}

export class CodexSessionAdapter implements TraceAdapter {
  readonly manifest: AdapterManifest = {
    source: "codex",
    adapterVersion: "3.0.0",
    supportedFormatVersions: ["codex-jsonl-v1"],
    status: "implemented",
    topology: lookupTopologyCapability("codex", "3.0.0"),
  };

  async sniff(input: AdapterInput): Promise<boolean> {
    const part = singleAdapterPart(input);
    try {
      const first = objectRecord(readSessionRecords(decodeAdapterBytes(part.bytes))[0]?.value);
      return ["session_meta", "turn_context", "response_item", "event_msg"].includes(
        String(first?.type),
      );
    } catch {
      return false;
    }
  }

  async *parse(input: AdapterInput): AsyncIterable<AdapterRecord> {
    const normalized = normalizeAdapterInput(input);
    const parts: CodexPart[] = [];
    const byLane = new Map<string, CodexPart>();
    try {
      for (const part of normalized.parts) {
        const records = readSessionRecords(decodeAdapterBytes(part.bytes));
        const meta = objectRecord(
          records
            .map((record) => objectRecord(record.value))
            .find((object) => object?.type === "session_meta")?.payload,
        );
        const lane = stringValue(meta?.id) ?? `${input.sourceIdentity}-${part.path}`;
        const candidate: CodexPart = {
          path: part.path,
          records,
          lane,
          root: stringValue(meta?.session_id) ?? stringValue(meta?.forked_from_id) ?? lane,
          forkedFrom: stringValue(meta?.forked_from_id),
          parent: stringValue(meta?.parent_thread_id),
          historyMode: String(meta?.history_mode ?? "legacy"),
        };
        parts.push(candidate);
        byLane.set(lane, candidate);
      }
    } catch (error) {
      throw new MalformedAdapterInputError("codex", String(error));
    }
    if (parts.length === 0) throw new MalformedAdapterInputError("codex", "bundle is empty");
    for (const part of parts) {
      const visited = new Set<string>();
      let root = part.root;
      while (!visited.has(root)) {
        visited.add(root);
        const ancestor = byLane.get(root);
        if (!ancestor || ancestor.root === root) break;
        root = ancestor.root;
      }
      part.root = root;
    }
    const root = parts.find((part) => part.lane === part.root)?.lane ?? parts[0]!.root;
    const traceParts = parts.filter((part) => part.root === root);

    const toolNames = new Map<string, string>();
    const activityByChild = new Map<string, { parentLane: string; callId: string }>();
    for (const part of traceParts) {
      for (const record of part.records) {
        const object = objectRecord(record.value);
        const payload = objectRecord(object?.payload);
        if (!object || !payload) continue;
        if (
          object.type === "event_msg" &&
          payload.type === "sub_agent_activity" &&
          payload.kind === "started"
        ) {
          const child = stringValue(payload.agent_thread_id);
          const callId = stringValue(payload.event_id);
          if (child && callId) activityByChild.set(child, { parentLane: part.lane, callId });
        }
        if (
          object.type === "response_item" &&
          /function_call|tool_call/iu.test(String(payload.type ?? "")) &&
          !/output|result/iu.test(String(payload.type ?? ""))
        ) {
          const callId = stringValue(payload.call_id);
          if (callId) toolNames.set(callId, String(payload.name ?? payload.namespace ?? "tool"));
        }
        if (object.type === "response_item" && payload.type === "function_call_output") {
          try {
            const parsed = objectRecord(JSON.parse(String(payload.output ?? "")));
            const child = stringValue(parsed?.agent_id);
            const callId = stringValue(payload.call_id);
            if (child && callId && !activityByChild.has(child))
              activityByChild.set(child, { parentLane: part.lane, callId });
          } catch {
            /* Codex tool failures arrive as bare strings, not JSON. */
          }
        }
      }
    }
    const firstRequestPayload = objectRecord(
      traceParts
        .flatMap((part) => part.records)
        .map((record) => objectRecord(record.value))
        .find((object) => {
          const payload = objectRecord(object?.payload);
          return (
            (object?.type === "event_msg" && payload?.type === "user_message") ||
            (object?.type === "response_item" &&
              payload?.type === "message" &&
              payload?.role === "user")
          );
        })?.payload,
    );
    const tracePreview = displayPreview(
      firstRequestPayload?.message ?? firstRequestPayload?.content,
      120,
    );
    const traceTitle = tracePreview ? `Codex · ${tracePreview}` : "Codex session";
    const emittedPayloads = new Set<string>();
    const emittedMessages = new Set<string>();
    for (const part of [...traceParts].sort(
      (left, right) => Number(Boolean(left.forkedFrom)) - Number(Boolean(right.forkedFrom)),
    )) {
      const spawn = activityByChild.get(part.lane);
      const declaredParent = part.parent;
      for (const record of part.records) {
        const object = objectRecord(record.value);
        if (!object || typeof object.type !== "string") {
          yield {
            type: "warning",
            code: "unknown_record",
            message: `line ${record.line} has no type`,
          };
          continue;
        }
        const declaredVersion = typeof object.version === "string" ? object.version : undefined;
        const version = declaredVersion?.startsWith("codex-jsonl-")
          ? declaredVersion
          : "codex-jsonl-v1";
        if (!this.manifest.supportedFormatVersions.includes(version))
          throw new UnsupportedAdapterVersionError("codex", version);
        const payload = objectRecord(object.payload);
        const payloadType = String(payload?.type ?? "");
        const eventId =
          stringValue(object.id) ?? stringValue(payload?.id) ?? `${part.lane}-${record.line}`;
        if (
          !payload ||
          !supportedRecordTypes.has(object.type) ||
          sensitivePayloadTypes.has(payloadType)
        ) {
          yield {
            type: "warning",
            code: sensitivePayloadTypes.has(payloadType)
              ? "sensitive_reasoning_omitted"
              : "unsupported_record_omitted",
            message: `line ${record.line} ${object.type}/${payloadType || "none"} was omitted`,
            sourceEventId: eventId,
          };
          continue;
        }
        const payloadHash = hashValue(payload);
        if (part.forkedFrom && emittedPayloads.has(payloadHash)) continue;
        emittedPayloads.add(payloadHash);
        const author = payloadType === "agent_message" ? stringValue(payload.author) : null;
        const recipient = payloadType === "agent_message" ? stringValue(payload.recipient) : null;
        if (author && recipient) {
          const messageKey = `${author}\0${recipient}\0${hashValue(messageText(payload).match(/gAAAA[A-Za-z0-9_=-]*/u)?.[0] ?? messageText(payload))}`;
          if (emittedMessages.has(messageKey)) continue;
          emittedMessages.add(messageKey);
        }
        const sanitized = sanitizeVendorValue(object);
        const sanitizedObject = objectRecord(sanitized.value) ?? { type: object.type };
        const sanitizedPayload = objectRecord(sanitizedObject.payload);
        if (sanitized.reasoning > 0) {
          yield {
            type: "warning",
            code: "sensitive_reasoning_omitted",
            message: `line ${record.line} omitted ${sanitized.reasoning} reasoning block(s)`,
            sourceEventId: eventId,
          };
        }
        if (sanitized.confidential > 0) {
          yield {
            type: "warning",
            code: "sensitive_content_omitted",
            message: `line ${record.line} omitted ${sanitized.confidential} confidential field(s)`,
            sourceEventId: eventId,
          };
        }
        const activity = payloadType === "sub_agent_activity";
        const activityChild = activity ? stringValue(payload.agent_thread_id) : null;
        const eventLane = author ?? activityChild ?? part.lane;
        const attributes: Record<string, unknown> = {
          recordType: object.type,
          ...(payloadType ? { payloadType } : {}),
        };
        let parentSpanId: string | undefined;
        if (object.type === "session_meta" && declaredParent) {
          attributes.parentAgentId = declaredParent;
          attributes.topologyProvenance = spawn ? "stated" : "inferred";
          parentSpanId = spawn?.callId;
        }
        if (activity && activityChild) {
          const childPart = byLane.get(activityChild);
          attributes.parentAgentId = part.lane;
          attributes.spawnedAgentIds = [activityChild];
          attributes.topologyProvenance =
            childPart?.historyMode === "paginated" ? "inferred" : "stated";
          parentSpanId = stringValue(payload.event_id) ?? undefined;
        }
        const finalAnswer = Boolean(
          author && recipient && /FINAL_ANSWER/iu.test(messageText(payload)),
        );
        if (author && recipient) {
          attributes.senderAgentId = author;
          attributes.recipientAgentId = recipient;
          attributes.messageId = eventId;
          if (finalAnswer) {
            attributes.joinedBy = author;
            attributes.joinedAgentIds = [author];
          }
        }
        const display = codexDisplay(object.type, sanitizedPayload, toolNames);
        attributes.contentType = display.contentType;
        if (display.toolName) attributes.toolName = display.toolName;
        yield {
          type: "event",
          event: normalizeEvent(
            {
              source: "codex",
              formatVersion: version,
              adapterVersion: this.manifest.adapterVersion,
              sourceIdentity: input.sourceIdentity,
              sessionId: `${root}@${this.manifest.adapterVersion}`,
              line: record.line,
            },
            {
              sourceEventId: eventId,
              occurredAt: typeof object.timestamp === "string" ? object.timestamp : undefined,
              kind: finalAnswer ? "tool_result" : codexKind(object.type, sanitizedPayload),
              name: display.name,
              status: object.type === "event_msg" && payloadType === "error" ? "error" : "ok",
              agentId: finalAnswer && recipient ? recipient : eventLane,
              spanId: stringValue(payload.call_id) ?? undefined,
              parentSpanId,
              attributes,
              payload: sanitizedObject,
              traceTitle,
            },
          ),
        };
        yield {
          type: "artifact",
          key: `event-${eventId}`,
          sourceEventId: eventId,
          bytes: new TextEncoder().encode(JSON.stringify(sanitizedObject)),
          mediaType: "application/json",
        };
        if (finalAnswer && author) {
          yield {
            type: "event",
            event: normalizeEvent(
              {
                source: "codex",
                formatVersion: version,
                adapterVersion: this.manifest.adapterVersion,
                sourceIdentity: input.sourceIdentity,
                sessionId: `${root}@${this.manifest.adapterVersion}`,
                line: record.line,
              },
              {
                sourceEventId: `agent-end-${author}`,
                occurredAt: typeof object.timestamp === "string" ? object.timestamp : undefined,
                kind: "agent_end",
                name: displayName("Subagent final answer", author),
                status: "ok",
                agentId: author,
                attributes: {
                  recordType: "agent_end",
                  contentType: "agent_activity",
                  joinedBy: recipient ?? root,
                },
                payload: { agent: author, recipient },
                traceTitle,
              },
            ),
          };
        }
      }
    }
  }
}
