import type { RawEventKind } from "@intenttrace/schema";

import {
  decodeAdapterBytes,
  displayName,
  normalizeEvent,
  objectRecord,
  readSessionRecords,
  sanitizeVendorValue,
  visibleText,
  type SessionRecord,
} from "./common.js";
import { lookupTopologyCapability } from "./topology.js";
import {
  MalformedAdapterInputError,
  normalizeAdapterInput,
  singleAdapterPart,
  type AdapterInput,
  type AdapterManifest,
  type AdapterRecord,
  type TraceAdapter,
} from "./types.js";

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ompKind(value: Record<string, unknown>): RawEventKind {
  if (value.type === "session") return "agent_start";
  if (value.type === "session_init") return "agent_start";
  if (value.type === "custom_message") return "tool_result";
  if (value.type === "message") {
    const role = String(objectRecord(value.message)?.role ?? "");
    if (role === "toolResult") return "tool_result";
    if (role === "user") return "user_message";
    return "assistant_message";
  }
  return "log";
}

function ompText(object: Record<string, unknown>): string {
  const message = objectRecord(object.message);
  if (message) {
    const content = Array.isArray(message.content)
      ? message.content
          .map((item) => objectRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
          .filter((item) => item.type === "text" || item.type === "toolCall")
          .map((item) =>
            item.type === "toolCall" ? String(item.name ?? "tool") : String(item.text ?? ""),
          )
          .join(" ")
      : visibleText(message.content);
    return content || String(message.toolName ?? message.role ?? "");
  }
  if (typeof object.content === "string") return object.content;
  return String(object.customType ?? object.type ?? "");
}

interface OmpPart {
  path: string;
  lane: string;
  records: SessionRecord[];
}

export class OmpSessionAdapter implements TraceAdapter {
  readonly manifest: AdapterManifest = {
    source: "omp",
    adapterVersion: "1.0.0",
    supportedFormatVersions: ["omp-jsonl-v1"],
    status: "implemented",
    topology: lookupTopologyCapability("omp", "1.0.0"),
  };

  async sniff(input: AdapterInput): Promise<boolean> {
    try {
      return (
        objectRecord(
          readSessionRecords(decodeAdapterBytes(singleAdapterPart(input).bytes))[1]?.value,
        )?.type === "session"
      );
    } catch {
      return false;
    }
  }

  async *parse(input: AdapterInput): AsyncIterable<AdapterRecord> {
    const normalized = normalizeAdapterInput(input);
    const root = normalized.parts.find((part) => !part.path.includes("/"));
    if (!root) throw new MalformedAdapterInputError("omp", "bundle requires root session file");
    const parts: OmpPart[] = [];
    let rootId = root.path;
    try {
      for (const part of normalized.parts) {
        const records = readSessionRecords(decodeAdapterBytes(part.bytes));
        const header = objectRecord(records[1]?.value);
        if (part.path === root.path) rootId = str(header?.id) ?? root.path;
        parts.push({
          path: part.path,
          lane:
            part.path === root.path
              ? "Main"
              : part.path
                  .split("/")
                  .at(-1)!
                  .replace(/\.jsonl$/iu, ""),
          records: records.slice(1),
        });
      }
    } catch (error) {
      throw new MalformedAdapterInputError("omp", String(error));
    }

    const childLanes = new Set(
      parts.filter((part) => part.lane !== "Main").map((part) => part.lane),
    );
    const spawnedLanes = new Set<string>();
    const joins = new Set<string>();
    const peers = new Map<string, { from: string; to: string; messageId: string }>();
    for (const part of parts) {
      for (const record of part.records) {
        const object = objectRecord(record.value);
        if (!object) continue;
        const message = objectRecord(object.message);
        const details = objectRecord(object.details) ?? objectRecord(message?.details);
        if (!details) continue;
        if (details.__synthetic === true || details.executed === false) continue;
        const progress = Array.isArray(details.progress) ? details.progress : [];
        for (const item of progress) {
          const entry = objectRecord(item);
          if (!entry || entry.__synthetic === true || entry.executed === false) continue;
          const id = str(entry.id);
          if (id && childLanes.has(id)) spawnedLanes.add(id);
        }
        const jobs = Array.isArray(details.jobs) ? details.jobs : [];
        for (const item of jobs) {
          const id = str(objectRecord(item)?.id) ?? str(objectRecord(item)?.jobId);
          if (id) joins.add(id);
        }
        const waited = objectRecord(details.waited);
        const from = str(waited?.from);
        const to = str(waited?.to);
        if (from && to) {
          peers.set(`${part.path}:${record.line}`, {
            from,
            to,
            messageId: str(waited?.id) ?? `${from}-${to}-${record.line}`,
          });
        }
      }
    }

    for (const part of parts) {
      for (const record of part.records) {
        const object = objectRecord(record.value);
        if (!object) continue;
        const eventId = str(object.id) ?? `${part.lane}-${record.line}`;
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
        const details =
          objectRecord(object.details) ?? objectRecord(objectRecord(object.message)?.details);
        const jobIds = Array.isArray(details?.jobs)
          ? details.jobs
              .map((item) => str(objectRecord(item)?.id) ?? str(objectRecord(item)?.jobId))
              .filter((value): value is string => value !== null && childLanes.has(value))
          : [];
        const attributes: Record<string, unknown> = {
          recordType: String(object.type ?? "unknown"),
          contentType: String(object.customType ?? object.type ?? "record"),
        };
        if (spawnedLanes.has(part.lane)) {
          attributes.parentAgentId = "Main";
          attributes.topologyProvenance = "inferred";
        }
        if (part.lane === "Main" && spawnedLanes.size > 0 && Array.isArray(details?.progress)) {
          attributes.spawnedAgentIds = [...spawnedLanes].sort();
        }
        if (part.lane === "Main" && jobIds.length > 0) {
          attributes.joinedAgentIds = [...new Set(jobIds)].sort();
        }
        // Peer fidelity is `stated` in the OMP capability declaration, so the
        // record carries no fact-level provenance: `topologyProvenance` is only
        // ever a downgrade and must not overwrite an inferred spawn fact.
        const peer = peers.get(`${part.path}:${record.line}`);
        if (peer) {
          attributes.senderAgentId = peer.from;
          attributes.recipientAgentId = peer.to;
          attributes.messageId = peer.messageId;
        }
        yield {
          type: "event",
          event: normalizeEvent(
            {
              source: "omp",
              formatVersion: "omp-jsonl-v1",
              adapterVersion: this.manifest.adapterVersion,
              sourceIdentity: input.sourceIdentity,
              sessionId: `${rootId}@${this.manifest.adapterVersion}`,
              line: record.line,
            },
            {
              sourceEventId: eventId,
              occurredAt: typeof object.timestamp === "string" ? object.timestamp : undefined,
              kind: ompKind(object),
              name: displayName(`OMP ${part.lane}`, ompText(sanitizedObject)),
              status: "ok",
              agentId: part.lane,
              spanId: str(objectRecord(object.message)?.toolCallId) ?? undefined,
              attributes,
              payload: sanitizedObject,
              traceTitle: "OMP session",
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
      }
    }

    for (const lane of [...joins].filter((candidate) => childLanes.has(candidate)).sort()) {
      yield {
        type: "event",
        event: normalizeEvent(
          {
            source: "omp",
            formatVersion: "omp-jsonl-v1",
            adapterVersion: this.manifest.adapterVersion,
            sourceIdentity: input.sourceIdentity,
            sessionId: `${rootId}@${this.manifest.adapterVersion}`,
            line: 0,
          },
          {
            sourceEventId: `agent-end-${lane}`,
            kind: "agent_end",
            name: displayName("OMP subagent finished", lane),
            status: "ok",
            agentId: lane,
            attributes: {
              recordType: "agent_end",
              contentType: "agent_activity",
              joinedBy: "Main",
            },
            payload: { agent: lane, parent: "Main" },
            traceTitle: "OMP session",
          },
        ),
      };
    }
  }
}
