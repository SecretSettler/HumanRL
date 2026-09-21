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
  "user",
  "assistant",
  "system",
  "mode",
  "permission-mode",
  "progress",
  "tool_use",
  "tool_result",
]);
const recognizedRecordTypes = new Set([
  ...supportedRecordTypes,
  "ai-title",
  "attachment",
  "file-history-delta",
  "file-history-snapshot",
  "last-prompt",
  "queue-operation",
  "summary",
]);

function claudeContentTypes(object: Record<string, unknown>): Set<string> {
  const message = objectRecord(object.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return new Set(
    content
      .map((block) => objectRecord(block))
      .filter((block): block is Record<string, unknown> => block !== null)
      .map((block) => String(block.type ?? "")),
  );
}

function claudeKind(type: string, object: Record<string, unknown>): RawEventKind {
  if (object.is_error === true || object.isApiErrorMessage === true || object.error) return "error";
  const contentTypes = claudeContentTypes(object);
  if (type === "user") return contentTypes.has("tool_result") ? "tool_result" : "user_message";
  if (type === "assistant") return contentTypes.has("tool_use") ? "tool_call" : "assistant_message";
  if (type === "tool_use") return "tool_call";
  if (type === "tool_result") return "tool_result";
  return "log";
}

function claudeDisplay(
  type: string,
  object: Record<string, unknown>,
): { name: string; toolName?: string; contentType: string } {
  const message = objectRecord(object.message);
  const content = Array.isArray(message?.content) ? message.content : message?.content;
  const firstBlock = Array.isArray(content) ? objectRecord(content[0]) : null;
  if (type === "user") {
    return firstBlock?.type === "tool_result"
      ? { name: displayName("Tool result", firstBlock.content), contentType: "tool_result" }
      : { name: displayName("User", content), contentType: "user_message" };
  }
  if (type === "assistant") {
    if (firstBlock?.type === "tool_use") {
      const toolName = String(firstBlock.name ?? "tool");
      return {
        name: displayName(`Tool call: ${toolName}`, firstBlock.input),
        toolName,
        contentType: "tool_call",
      };
    }
    return { name: displayName("Assistant", content), contentType: "assistant_message" };
  }
  if (type === "system")
    return { name: displayName("System", object.content), contentType: "system" };
  if (type === "progress")
    return {
      name: displayName("Progress", object.content ?? object.data),
      contentType: "progress",
    };
  if (type === "tool_use") {
    const toolName = String(object.name ?? "tool");
    return {
      name: displayName(`Tool call: ${toolName}`, object.input),
      toolName,
      contentType: "tool_call",
    };
  }
  if (type === "tool_result")
    return { name: displayName("Tool result", object.content), contentType: "tool_result" };
  return { name: displayName(`Claude ${type}`, object), contentType: "metadata" };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface ClaudePart {
  path: string;
  records: SessionRecord[];
  lane: string;
  isChild: boolean;
  sidecar: Record<string, unknown> | null;
  firstTimestamp: string;
}

export class ClaudeSessionAdapter implements TraceAdapter {
  readonly manifest: AdapterManifest = {
    source: "claude",
    adapterVersion: "3.0.0",
    supportedFormatVersions: ["claude-jsonl-v1"],
    status: "implemented",
    topology: lookupTopologyCapability("claude", "3.0.0"),
  };

  async sniff(input: AdapterInput): Promise<boolean> {
    const part = singleAdapterPart(input);
    try {
      return recognizedRecordTypes.has(
        String(objectRecord(readSessionRecords(decodeAdapterBytes(part.bytes))[0]?.value)?.type),
      );
    } catch {
      return false;
    }
  }

  async *parse(input: AdapterInput): AsyncIterable<AdapterRecord> {
    const normalized = normalizeAdapterInput(input);
    const parts: ClaudePart[] = [];
    let rootSession = input.sourceIdentity;
    try {
      for (const part of normalized.parts) {
        if (part.path.endsWith(".meta.json")) continue;
        const records = readSessionRecords(decodeAdapterBytes(part.bytes));
        const first = objectRecord(records[0]?.value);
        const sessionId = stringValue(first?.sessionId) ?? input.sourceIdentity;
        const isChild = part.path.includes("/subagents/") || part.path.startsWith("subagents/");
        if (!isChild) rootSession = sessionId;
        const childAgent = stringValue(first?.agentId);
        parts.push({
          path: part.path,
          records,
          lane: childAgent ?? sessionId,
          isChild,
          sidecar: null,
          firstTimestamp: String(first?.timestamp ?? ""),
        });
      }
      for (const part of normalized.parts.filter((candidate) =>
        candidate.path.endsWith(".meta.json"),
      )) {
        const object = objectRecord(JSON.parse(decodeAdapterBytes(part.bytes)));
        const agentId = part.path.match(/agent-([^/.]+)\.meta\.json$/u)?.[1];
        const target = parts.find((candidate) => candidate.path.includes(`agent-${agentId}.jsonl`));
        if (target) target.sidecar = object;
      }
    } catch (error) {
      throw new MalformedAdapterInputError("claude", String(error));
    }
    for (const part of parts) {
      if (part.isChild)
        part.lane =
          part.lane === rootSession
            ? (part.path.match(/agent-([^/.]+)\.jsonl$/u)?.[1] ?? part.lane)
            : part.lane;
    }

    const laneNames = new Set(parts.map((part) => part.lane));
    const coordinatorLanes = new Set<string>();
    const senderFacts: Array<{ from: string; to: string; eventId: string }> = [];
    for (const part of parts) {
      for (const record of part.records) {
        const object = objectRecord(record.value);
        if (!object) continue;
        if (objectRecord(object.origin)?.kind === "coordinator") coordinatorLanes.add(part.lane);
        const blocks = Array.isArray(objectRecord(object.message)?.content)
          ? (objectRecord(object.message)!.content as unknown[])
          : [];
        for (const block of blocks) {
          const item = objectRecord(block);
          if (item?.type === "tool_use" && item.name === "SendMessage") {
            const to = stringValue(objectRecord(item.input)?.to);
            const eventId =
              stringValue(object.uuid) ?? stringValue(object.id) ?? `${part.lane}-${record.line}`;
            if (to) senderFacts.push({ from: part.lane, to, eventId });
          }
        }
      }
    }
    const pairedMessages = new Set(
      senderFacts
        .filter((fact) => coordinatorLanes.has(fact.to) && laneNames.has(fact.to))
        .map((fact) => fact.eventId),
    );

    const asyncJoins = new Set<string>();
    const firstRequest = parts
      .flatMap((part) => part.records)
      .map((record) => objectRecord(record.value))
      .find((object) => object?.type === "user" && objectRecord(object.message)?.role === "user");
    const tracePreview = displayPreview(objectRecord(firstRequest?.message)?.content, 120);
    const traceTitle = tracePreview ? `Claude · ${tracePreview}` : "Claude session";
    const emit = (
      part: ClaudePart,
      line: number,
      details: {
        sourceEventId: string;
        occurredAt?: string | undefined;
        kind: RawEventKind;
        name: string;
        status: "ok" | "error";
        agentId: string;
        spanId?: string | undefined;
        parentSpanId?: string | undefined;
        attributes: Record<string, unknown>;
        payload: unknown;
      },
    ): AdapterRecord => ({
      type: "event",
      event: normalizeEvent(
        {
          source: "claude",
          formatVersion: "claude-jsonl-v1",
          adapterVersion: this.manifest.adapterVersion,
          sourceIdentity: input.sourceIdentity,
          sessionId: `${rootSession}@${this.manifest.adapterVersion}`,
          line,
        },
        { ...details, traceTitle },
      ),
    });

    for (const part of parts) {
      const toolUseId = stringValue(part.sidecar?.toolUseId);
      if (!part.isChild || !toolUseId) continue;
      const parentAgentId = stringValue(part.sidecar?.parentAgentId) ?? rootSession;
      const sourceEventId = `agent-start-${part.lane}`;
      yield emit(part, 0, {
        sourceEventId,
        occurredAt: part.firstTimestamp || undefined,
        kind: "agent_start",
        name: displayName("Subagent started", part.sidecar?.description ?? part.lane),
        status: "ok",
        agentId: part.lane,
        spanId: `${toolUseId}-child`,
        parentSpanId: toolUseId,
        attributes: {
          recordType: "agent_start",
          contentType: "agent_activity",
          parentAgentId,
          topologyProvenance: "stated",
          agentType: stringValue(part.sidecar?.agentType) ?? "subagent",
        },
        payload: { agentId: part.lane, toolUseId, parentAgentId },
      });
      const joinedByResult = parts.some(
        (candidate) => candidate.path.endsWith(".jsonl") && !candidate.isChild,
      )
        ? true
        : false;
      if (joinedByResult) {
        yield emit(part, 1, {
          sourceEventId: `agent-end-${part.lane}`,
          kind: "agent_end",
          name: displayName("Subagent finished", part.lane),
          status: "ok",
          agentId: part.lane,
          spanId: `${toolUseId}-child`,
          attributes: {
            recordType: "agent_end",
            contentType: "agent_activity",
            joinedBy: parentAgentId,
          },
          payload: { agentId: part.lane, toolUseId, parentAgentId },
        });
      }
    }

    const allRecords = parts
      .flatMap((part) => part.records.map((record) => ({ part, record })))
      .sort(
        (left, right) =>
          String(objectRecord(left.record.value)?.timestamp ?? "").localeCompare(
            String(objectRecord(right.record.value)?.timestamp ?? ""),
          ) || left.record.line - right.record.line,
      );

    for (const { part, record } of allRecords) {
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
      const version = declaredVersion?.startsWith("claude-jsonl-")
        ? declaredVersion
        : "claude-jsonl-v1";
      if (!this.manifest.supportedFormatVersions.includes(version))
        throw new UnsupportedAdapterVersionError("claude", version);
      const eventId =
        stringValue(object.uuid) ?? stringValue(object.id) ?? `${part.lane}-${record.line}`;
      if (!supportedRecordTypes.has(object.type)) {
        yield {
          type: "warning",
          code: "unsupported_record_omitted",
          message: `line ${record.line} ${object.type} was omitted`,
          sourceEventId: eventId,
        };
        continue;
      }
      const sanitized = sanitizeVendorValue(object);
      const sanitizedObject = objectRecord(sanitized.value) ?? { type: object.type };
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
      const display = claudeDisplay(object.type, sanitizedObject);
      const attributes: Record<string, unknown> = {
        recordType: object.type,
        contentType: display.contentType,
        ...(display.toolName ? { toolName: display.toolName } : {}),
      };
      const message = objectRecord(object.message);
      const content = message?.content;
      const blocks = Array.isArray(content)
        ? content
            .map((item) => objectRecord(item))
            .filter((item): item is Record<string, unknown> => item !== null)
        : [];
      const toolResult = objectRecord(object.toolUseResult);
      const joinedAgent = toolResult ? stringValue(toolResult.agentId) : null;
      if (joinedAgent && toolResult?.status !== "async_launched") {
        attributes.joinedBy = joinedAgent;
        attributes.joinedAgentIds = [joinedAgent];
      }
      let spanId: string | undefined;
      for (const block of blocks) {
        if (block.type === "tool_use" && stringValue(block.id)) spanId = stringValue(block.id)!;
        if (
          block.type === "tool_use" &&
          block.name === "SendMessage" &&
          pairedMessages.has(eventId)
        ) {
          const to = stringValue(objectRecord(block.input)?.to);
          if (to) {
            attributes.senderAgentId = part.lane;
            attributes.recipientAgentId = to;
            attributes.messageId = eventId;
            attributes.topologyProvenance = "inferred";
          }
        }
        if (block.type === "tool_result" && stringValue(block.tool_use_id))
          spanId = stringValue(block.tool_use_id)!;
      }
      if (
        typeof content === "string" &&
        objectRecord(object.origin)?.kind === "task-notification"
      ) {
        const taskId = content.match(/<task-id>([^<]+)</u)?.[1];
        const taskToolId = content.match(/<tool-use-id>([^<]+)</u)?.[1];
        const dedupeKey = `${taskId}\0${taskToolId}`;
        if (
          taskId &&
          taskToolId &&
          parts.some((candidate) => candidate.lane === taskId && candidate.sidecar !== null)
        ) {
          if (asyncJoins.has(dedupeKey)) {
            yield {
              type: "warning",
              code: "duplicate_async_join_omitted",
              message: `line ${record.line} repeated task notification`,
              sourceEventId: eventId,
            };
          } else {
            asyncJoins.add(dedupeKey);
            attributes.joinedBy = taskId;
            attributes.joinedAgentIds = [taskId];
          }
        }
      }
      const status =
        object.is_error === true || object.isApiErrorMessage === true || Boolean(object.error)
          ? "error"
          : "ok";
      yield emit(part, record.line, {
        sourceEventId: eventId,
        occurredAt: typeof object.timestamp === "string" ? object.timestamp : undefined,
        kind: claudeKind(object.type, sanitizedObject),
        name: display.name,
        status,
        agentId: part.lane,
        spanId,
        attributes,
        payload: sanitizedObject,
      });
      yield {
        type: "artifact",
        key: `event-${eventId}`,
        sourceEventId: eventId,
        bytes: new TextEncoder().encode(JSON.stringify(sanitizedObject)),
        mediaType: "application/json",
      };
    }
  }
}
