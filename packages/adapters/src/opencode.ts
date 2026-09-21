import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { RawEventKind } from "@intenttrace/schema";

import {
  decodeAdapterBytes,
  displayName,
  normalizeEvent,
  objectRecord,
  sanitizeVendorValue,
} from "./common.js";
import {
  normalizeAdapterInput,
  singleAdapterPart,
  UnsupportedAdapterVersionError,
  MalformedAdapterInputError,
  type AdapterInput,
  type AdapterManifest,
  type AdapterRecord,
  type TraceAdapter,
} from "./types.js";
import { lookupTopologyCapability } from "./topology.js";

interface SessionRow {
  id: string;
  parent_id: string | null;
  version: string;
  time_created: number;
  agent: string | null;
}
interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return objectRecord(value) ?? {};
  try {
    return objectRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventKind(data: Record<string, unknown>): RawEventKind {
  if (data.type === "tool") return "tool_call";
  if (data.type === "text") return "assistant_message";
  return "log";
}

function taskEnvelope(output: string): { child: string | null; text: string; state: string } {
  const modern = output.match(
    /<task\s+id="([^"]+)"\s+state="([^"]+)"[^>]*>[\s\S]*?<task_(?:result|error)>\s*([\s\S]*?)(?:<\/task_(?:result|error)>|$)/iu,
  );
  if (modern) return { child: modern[1]!, state: modern[2]!, text: modern[3]!.trim() };
  const legacy = output.match(
    /task_id:\s*(\S+)[\s\S]*?<task_result>\s*([\s\S]*?)(?:<\/task_result>|$)/iu,
  );
  return legacy
    ? { child: legacy[1]!, state: "completed", text: legacy[2]!.trim() }
    : { child: null, state: "unknown", text: output.slice(0, 800) };
}

export class OpenCodeSessionAdapter implements TraceAdapter {
  readonly manifest: AdapterManifest = {
    source: "opencode",
    adapterVersion: "1.0.0",
    supportedFormatVersions: ["opencode-sqlite-v1"],
    status: "implemented",
    topology: lookupTopologyCapability("opencode", "1.0.0"),
  };

  async sniff(input: AdapterInput): Promise<boolean> {
    try {
      const part = singleAdapterPart(input);
      return (
        part.bytes.length > 15 &&
        new TextDecoder().decode(part.bytes.subarray(0, 15)) === "SQLite format 3"
      );
    } catch {
      return false;
    }
  }

  async *parse(input: AdapterInput): AsyncIterable<AdapterRecord> {
    const normalized = normalizeAdapterInput(input);
    const dbPart = normalized.parts.find((part) => /(?:^|\/)opencode\.db$/u.test(part.path));
    if (!dbPart) throw new MalformedAdapterInputError("opencode", "bundle requires opencode.db");
    const work = await mkdtemp(join(tmpdir(), "intenttrace-opencode-"));
    try {
      await writeFile(join(work, "opencode.db"), dbPart.bytes);
      for (const name of ["opencode.db-wal", "opencode.db-shm"] as const) {
        const part = normalized.parts.find(
          (candidate) => candidate.path === name || candidate.path.endsWith(`/${name}`),
        );
        if (part) await writeFile(join(work, name), part.bytes);
      }
      const overflowByPath = new Map(
        normalized.parts
          .filter((part) => part.path.startsWith("tool-output/"))
          .map((part) => [part.path, part.bytes]),
      );
      const overflowBasenameCounts = new Map<string, number>();
      for (const part of normalized.parts.filter((candidate) =>
        candidate.path.startsWith("tool-output/"),
      )) {
        const basename = posix.basename(part.path);
        overflowBasenameCounts.set(basename, (overflowBasenameCounts.get(basename) ?? 0) + 1);
      }
      const db = new DatabaseSync(join(work, "opencode.db"), { readOnly: true });
      try {
        const sessions = db
          .prepare(
            "SELECT id,parent_id,version,time_created,agent FROM session ORDER BY time_created ASC, id ASC",
          )
          .all() as unknown as SessionRow[];
        const sessionIds = new Set(sessions.map((session) => session.id));
        const rootOf = (id: string): string => {
          const seen = new Set<string>();
          let current = id;
          while (!seen.has(current)) {
            seen.add(current);
            const parent = sessions.find((session) => session.id === current)?.parent_id;
            if (!parent || !sessionIds.has(parent)) break;
            current = parent;
          }
          return current;
        };
        const parts = db
          .prepare(
            "SELECT id,message_id,session_id,time_created,data FROM part ORDER BY time_created ASC,id ASC",
          )
          .all() as unknown as PartRow[];

        const spawnByChild = new Map<
          string,
          { parent: string; callId: string | null; joined: boolean; joinTime: number }
        >();
        for (const part of parts) {
          const data = parseJson(part.data);
          if (data.type !== "tool" || data.tool !== "task") continue;
          const state = objectRecord(data.state) ?? {};
          const metadata = objectRecord(state.metadata) ?? {};
          const envelope = taskEnvelope(String(state.output ?? ""));
          const child = str(metadata.sessionId) ?? envelope.child;
          if (!child) continue;
          spawnByChild.set(child, {
            parent: str(metadata.parentSessionId) ?? part.session_id,
            callId: str(data.callID),
            joined: envelope.child !== null && envelope.state !== "running",
            joinTime: part.time_created,
          });
        }

        for (const session of sessions) {
          const root = rootOf(session.id);
          const spawn = spawnByChild.get(session.id);
          const payload = { id: session.id, parent_id: session.parent_id, agent: session.agent };
          const event = normalizeEvent(
            {
              source: "opencode",
              formatVersion: "opencode-sqlite-v1",
              adapterVersion: this.manifest.adapterVersion,
              sourceIdentity: input.sourceIdentity,
              sessionId: `${root}@${this.manifest.adapterVersion}`,
              line: session.time_created,
            },
            {
              sourceEventId: `session-${session.id}`,
              occurredAt: new Date(session.time_created).toISOString(),
              kind: "agent_start",
              name: displayName("OpenCode session", session.agent ?? session.id),
              agentId: session.id,
              ...(session.parent_id && spawn?.callId ? { parentSpanId: spawn.callId } : {}),
              attributes: {
                recordType: "session",
                contentType: "session",
                laneKey: session.id,
                ...(session.parent_id
                  ? { parentAgentId: session.parent_id, topologyProvenance: "stated" }
                  : {}),
              },
              payload,
              traceTitle: "OpenCode session",
            },
          );
          yield { type: "event", event };
          yield {
            type: "artifact",
            key: `event-${event.source.sourceEventId}`,
            sourceEventId: event.source.sourceEventId,
            bytes: new TextEncoder().encode(JSON.stringify(payload)),
            mediaType: "application/json",
          };
          if (spawn?.joined) {
            yield {
              type: "event",
              event: normalizeEvent(
                {
                  source: "opencode",
                  formatVersion: "opencode-sqlite-v1",
                  adapterVersion: this.manifest.adapterVersion,
                  sourceIdentity: input.sourceIdentity,
                  sessionId: `${root}@${this.manifest.adapterVersion}`,
                  line: spawn.joinTime,
                },
                {
                  sourceEventId: `agent-end-${session.id}`,
                  occurredAt: new Date(spawn.joinTime).toISOString(),
                  kind: "agent_end",
                  name: displayName("OpenCode subagent finished", session.id),
                  agentId: session.id,
                  attributes: {
                    recordType: "session_end",
                    contentType: "agent_activity",
                    joinedBy: spawn.parent,
                  },
                  payload: { id: session.id, parent_id: spawn.parent },
                  traceTitle: "OpenCode session",
                },
              ),
            };
          }
        }
        for (const part of parts) {
          const data = parseJson(part.data);
          const state = objectRecord(data.state) ?? {};
          const metadata = objectRecord(state.metadata) ?? {};
          const root = rootOf(part.session_id);
          const eventId = `part-${part.id}`;
          const task = data.type === "tool" && data.tool === "task";
          const status = String(state.status ?? "ok");
          let output = String(state.output ?? "");
          let recovered = false;
          if (
            task &&
            (metadata.truncated === true ||
              output.includes("[Session persistence truncated large content]"))
          ) {
            const outputPath = str(metadata.outputPath);
            const normalizedOutputPath = outputPath?.replaceAll("\\", "/");
            const pathValid =
              normalizedOutputPath?.startsWith("tool-output/") === true &&
              !normalizedOutputPath.split("/").includes("..");
            const basename = normalizedOutputPath ? posix.basename(normalizedOutputPath) : "";
            const ambiguous = (overflowBasenameCounts.get(basename) ?? 0) > 1;
            const bytes =
              pathValid && !ambiguous && normalizedOutputPath
                ? overflowByPath.get(normalizedOutputPath)
                : undefined;
            if (outputPath && (!pathValid || ambiguous))
              yield {
                type: "warning",
                code: "truncated_output_overflow_ambiguous",
                message: "OpenCode overflow reference is ambiguous or outside the supplied bundle",
                sourceEventId: eventId,
              };
            if (bytes) {
              output = decodeAdapterBytes(bytes);
              recovered = true;
            } else if (!outputPath || pathValid)
              yield {
                type: "warning",
                code: "truncated_output_unresolved",
                message: "OpenCode truncated task output has no supplied overflow part",
                sourceEventId: eventId,
              };
          }
          const envelope = task ? taskEnvelope(output) : null;
          const child = task ? (str(metadata.sessionId) ?? envelope?.child ?? null) : null;
          const joined = Boolean(envelope?.child) && envelope?.state !== "running";
          const attributes: Record<string, unknown> = {
            recordType: "part",
            contentType: String(data.type ?? "unknown"),
            partType: String(data.type ?? "unknown"),
          };
          if (child) {
            attributes.spawnedAgentIds = [child];
            attributes.topologyProvenance = "stated";
          }
          if (joined && envelope?.child) {
            attributes.joinedAgentIds = [envelope.child];
          }
          if (recovered) {
            attributes.overflowRecovered = true;
            attributes.recoveredResultPreview = envelope?.text.slice(0, 200) ?? "";
            yield {
              type: "warning",
              code: "truncated_output_overflow_used",
              message: "OpenCode truncated task output recovered from supplied overflow part",
              sourceEventId: eventId,
            };
          }
          const sanitized = sanitizeVendorValue(
            recovered ? { ...data, state: { ...state, output } } : data,
          );
          const sanitizedPayload = objectRecord(sanitized.value) ?? {};
          if (sanitized.reasoning > 0) {
            yield {
              type: "warning",
              code: "sensitive_reasoning_omitted",
              message: `part ${part.id} omitted ${sanitized.reasoning} reasoning block(s)`,
              sourceEventId: eventId,
            };
          }
          if (sanitized.confidential > 0) {
            yield {
              type: "warning",
              code: "sensitive_content_omitted",
              message: `part ${part.id} omitted ${sanitized.confidential} confidential field(s)`,
              sourceEventId: eventId,
            };
          }
          const event = normalizeEvent(
            {
              source: "opencode",
              formatVersion: "opencode-sqlite-v1",
              adapterVersion: this.manifest.adapterVersion,
              sourceIdentity: input.sourceIdentity,
              sessionId: `${root}@${this.manifest.adapterVersion}`,
              line: part.time_created,
            },
            {
              sourceEventId: eventId,
              occurredAt: new Date(part.time_created).toISOString(),
              kind: task
                ? joined || status === "error"
                  ? "tool_result"
                  : "tool_call"
                : eventKind(data),
              name: task
                ? displayName("OpenCode task", objectRecord(state.input)?.description ?? data.tool)
                : displayName("OpenCode part", data.type),
              status: task && status === "error" ? "error" : "ok",
              agentId: part.session_id,
              spanId: task ? (str(data.callID) ?? undefined) : undefined,
              attributes,
              payload: sanitizedPayload,
              traceTitle: "OpenCode session",
            },
          );
          yield { type: "event", event };
          yield {
            type: "artifact",
            key: `event-${eventId}`,
            sourceEventId: eventId,
            bytes: new TextEncoder().encode(JSON.stringify(sanitizedPayload)),
            mediaType: "application/json",
          };
        }
      } finally {
        db.close();
      }
    } catch (error) {
      if (
        error instanceof MalformedAdapterInputError ||
        error instanceof UnsupportedAdapterVersionError
      )
        throw error;
      throw new MalformedAdapterInputError("opencode", String(error));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
