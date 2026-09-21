import {
  decodeAdapterBytes,
  displayName,
  normalizeEvent,
  objectRecord,
  readSessionRecords,
  sanitizeVendorValue,
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

function jsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    return objectRecord(JSON.parse(decodeAdapterBytes(bytes)));
  } catch {
    return null;
  }
}

function chainRoot(id: string, links: ReadonlyMap<string, string>): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const next = links.get(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

interface GrokSession {
  id: string;
  records: SessionRecord[];
}

interface GrokSpawn {
  parent: string;
  child: string;
  promptId: string | null;
  timestamp: string | undefined;
}

export class GrokSessionAdapter implements TraceAdapter {
  readonly manifest: AdapterManifest = {
    source: "grok",
    adapterVersion: "1.0.0",
    supportedFormatVersions: ["grok-session-v1"],
    status: "implemented",
    topology: lookupTopologyCapability("grok", "1.0.0"),
  };

  async sniff(input: AdapterInput): Promise<boolean> {
    try {
      const part = singleAdapterPart(input);
      if (!/updates\.jsonl$/iu.test(part.path)) return false;
      const first = objectRecord(readSessionRecords(decodeAdapterBytes(part.bytes))[0]?.value);
      return typeof first?.method === "string" && String(first.method).endsWith("session/update");
    } catch {
      return false;
    }
  }

  async *parse(input: AdapterInput): AsyncIterable<AdapterRecord> {
    const normalized = normalizeAdapterInput(input);
    const sessions = new Map<string, GrokSession>();
    const parentBySession = new Map<string, string>();
    const resumeLinks = new Map<string, string>();
    const spawnByChild = new Map<string, GrokSpawn>();
    const joins = new Set<string>();
    const childByDirectory = new Map<string, string>();
    const finishedInStream = new Set<string>();
    try {
      for (const part of normalized.parts) {
        if (part.path.endsWith(".lock")) continue;
        if (part.path.endsWith("updates.jsonl")) {
          const records = readSessionRecords(decodeAdapterBytes(part.bytes));
          const id = records
            .map((record) => str(objectRecord(objectRecord(record.value)?.params)?.sessionId))
            .find((value): value is string => value !== null);
          if (!id) continue;
          const existing = sessions.get(id);
          sessions.set(id, { id, records: existing ? [...existing.records, ...records] : records });
          continue;
        }
        if (part.path.endsWith("meta.json")) {
          const object = jsonObject(part.bytes);
          const child = str(object?.child_session_id) ?? str(object?.subagent_id);
          const parent = str(object?.parent_session_id);
          const resumed = str(object?.resumed_from);
          const directory = part.path.split("/").slice(0, -1).join("/");
          if (child) childByDirectory.set(directory, child);
          if (child && parent) {
            parentBySession.set(child, parent);
            if (!spawnByChild.has(child))
              spawnByChild.set(child, { parent, child, promptId: null, timestamp: undefined });
          }
          if (child && resumed) resumeLinks.set(child, resumed);
          continue;
        }
        if (part.path.endsWith("output.json")) {
          const object = jsonObject(part.bytes);
          const directory = part.path.split("/").slice(0, -1).join("/");
          const child = childByDirectory.get(directory);
          if (child && object) joins.add(child);
          else if (object)
            yield {
              type: "warning",
              code: "output_identity_unresolved",
              message: "Grok output.json lacks a content-derived child identity",
            };
        }
      }
      for (const session of sessions.values()) {
        for (const record of session.records) {
          const object = objectRecord(record.value);
          const params = objectRecord(object?.params);
          const update = objectRecord(params?.update);
          if (!update) continue;
          if (update.sessionUpdate === "subagent_spawned") {
            const parent = str(params?.sessionId);
            const child = str(update.child_session_id) ?? str(update.subagent_id);
            if (!parent || !child) continue;
            parentBySession.set(child, parent);
            const resumed = str(update.resumed_from);
            if (resumed) resumeLinks.set(child, resumed);
            spawnByChild.set(child, {
              parent,
              child,
              promptId: str(update.parent_prompt_id),
              timestamp:
                typeof object?.timestamp === "number"
                  ? new Date(object.timestamp * 1000).toISOString()
                  : undefined,
            });
          }
          if (update.sessionUpdate === "subagent_finished") {
            const child = str(update.child_session_id) ?? str(update.subagent_id);
            if (child) {
              joins.add(child);
              finishedInStream.add(child);
            }
          }
        }
      }
    } catch (error) {
      throw new MalformedAdapterInputError("grok", String(error));
    }
    if (sessions.size === 0)
      throw new MalformedAdapterInputError("grok", "bundle contains no session updates");

    const laneOf = (id: string): string => chainRoot(id, resumeLinks);
    const traceRoot = chainRoot([...sessions.keys()][0]!, parentBySession);
    const traceOf = (id: string): string => chainRoot(id, parentBySession);

    for (const [child, spawn] of [...spawnByChild.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const lane = laneOf(child);
      const parentLane = laneOf(spawn.parent);
      if (lane === parentLane) continue;
      const sourceEventId = `agent-start-${child}`;
      yield {
        type: "event",
        event: normalizeEvent(
          {
            source: "grok",
            formatVersion: "grok-session-v1",
            adapterVersion: this.manifest.adapterVersion,
            sourceIdentity: input.sourceIdentity,
            sessionId: `${traceOf(child) || traceRoot}@${this.manifest.adapterVersion}`,
            line: 0,
          },
          {
            sourceEventId,
            occurredAt: spawn.timestamp,
            kind: "agent_start",
            name: displayName("Subagent spawned", child),
            status: "ok",
            agentId: lane,
            ...(spawn.promptId ? { parentSpanId: spawn.promptId } : {}),
            attributes: {
              recordType: "subagent_spawned",
              contentType: "agent_activity",
              parentAgentId: parentLane,
              topologyProvenance: "stated",
            },
            payload: {
              child_session_id: child,
              parent_session_id: spawn.parent,
              parent_prompt_id: spawn.promptId,
            },
            traceTitle: "Grok session",
          },
        ),
      };
    }

    for (const child of [...joins].sort()) {
      const lane = laneOf(child);
      const parent = parentBySession.get(child);
      const trace = traceOf(child) || traceRoot;
      const context = {
        source: "grok" as const,
        formatVersion: "grok-session-v1",
        adapterVersion: this.manifest.adapterVersion,
        sourceIdentity: input.sourceIdentity,
        sessionId: `${trace}@${this.manifest.adapterVersion}`,
        line: 0,
      };
      if (parent && !finishedInStream.has(child)) {
        yield {
          type: "event",
          event: normalizeEvent(context, {
            sourceEventId: `join-${child}`,
            kind: "tool_result",
            name: displayName("Subagent output collected", child),
            status: "ok",
            agentId: laneOf(parent),
            attributes: {
              recordType: "subagent_output",
              contentType: "agent_activity",
              joinedAgentIds: [lane],
              joinedBy: lane,
              topologyProvenance: "stated",
            },
            payload: { child_session_id: child },
            traceTitle: "Grok session",
          }),
        };
      }
      yield {
        type: "event",
        event: normalizeEvent(context, {
          sourceEventId: `agent-end-${child}`,
          kind: "agent_end",
          name: displayName("Subagent finished", child),
          status: "ok",
          agentId: lane,
          attributes: {
            recordType: "subagent_finished",
            contentType: "agent_activity",
            joinedBy: parent ? laneOf(parent) : lane,
          },
          payload: { child_session_id: child },
          traceTitle: "Grok session",
        }),
      };
    }

    for (const session of [...sessions.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )) {
      const lane = laneOf(session.id);
      const trace = traceOf(session.id) || traceRoot;
      for (const record of session.records) {
        const object = objectRecord(record.value);
        const params = objectRecord(object?.params);
        const update = objectRecord(params?.update);
        if (!object || !update) continue;
        if (update.sessionUpdate === "agent_thought_chunk") {
          yield {
            type: "warning",
            code: "sensitive_reasoning_omitted",
            message: `line ${record.line} agent_thought_chunk was omitted`,
            sourceEventId: `${session.id}-${record.line}`,
          };
          continue;
        }
        const eventId = str(objectRecord(params?._meta)?.eventId) ?? `${session.id}-${record.line}`;
        const sanitized = sanitizeVendorValue(object);
        const sanitizedObject = objectRecord(sanitized.value) ?? { method: object.method };
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
        const attributes: Record<string, unknown> = {
          recordType: String(update.sessionUpdate ?? object.method ?? "update"),
          contentType: "vendor_update",
        };
        const spawnedChild =
          update.sessionUpdate === "subagent_spawned"
            ? (str(update.child_session_id) ?? str(update.subagent_id))
            : null;
        if (spawnedChild) {
          attributes.spawnedAgentIds = [laneOf(spawnedChild)];
          attributes.topologyProvenance = "stated";
        }
        const finishedChild =
          update.sessionUpdate === "subagent_finished"
            ? (str(update.child_session_id) ?? str(update.subagent_id))
            : null;
        if (finishedChild) {
          attributes.joinedBy = laneOf(finishedChild);
          attributes.joinedAgentIds = [laneOf(finishedChild)];
        }
        yield {
          type: "event",
          event: normalizeEvent(
            {
              source: "grok",
              formatVersion: "grok-session-v1",
              adapterVersion: this.manifest.adapterVersion,
              sourceIdentity: input.sourceIdentity,
              sessionId: `${trace}@${this.manifest.adapterVersion}`,
              line: record.line,
            },
            {
              sourceEventId: eventId,
              occurredAt:
                typeof object.timestamp === "number"
                  ? new Date(object.timestamp * 1000).toISOString()
                  : undefined,
              kind: finishedChild ? "tool_result" : spawnedChild ? "tool_call" : "log",
              name: displayName(
                `Grok ${String(update.sessionUpdate ?? "update")}`,
                update.content ?? update.output ?? update.status,
              ),
              status: "ok",
              agentId: lane,
              attributes,
              payload: sanitizedObject,
              traceTitle: "Grok session",
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
  }
}
