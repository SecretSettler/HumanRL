import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  RawTraceEventInputSchema,
  SessionCatalogEntrySchema,
  type RawTraceEventInput,
  type SessionCatalogEntry,
  type TraceSourceKind,
} from "@intenttrace/schema";

import { sessionBundleContentSha256 } from "./common.js";
import { createAdapter } from "./registry.js";
import { normalizeAdapterInput, type AdapterPart, type TraceAdapter } from "./types.js";

export interface PreparedSessionWarning {
  code: string;
  message: string;
}

export interface SessionDescriptorMeta {
  /** 24 lowercase hex, satisfies `SessionCatalogIdSchema`. */
  id: string;
  byteLength: number;
  /** `TimestampSchema`: ISO-8601 with an explicit offset. */
  modifiedAt: string;
}

export interface PreparedTraceEvent {
  event: RawTraceEventInput;
  artifactKeys: readonly string[];
}

export interface PreparedTraceArtifact {
  key: string;
  sourceEventId: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface PreparedTraceBundle {
  source: TraceSourceKind;
  contentSha256: string;
  aggregateContentSha256: string;
  events: PreparedTraceEvent[];
  artifacts: PreparedTraceArtifact[];
  warnings: PreparedSessionWarning[];
  descriptor: SessionCatalogEntry;
  completionMarker: RawTraceEventInput;
}

function promptPreview(event: RawTraceEventInput): string | null {
  if (event.kind !== "user_message") return null;
  const preview = event.name.replace(/^User\s*[·:]?\s*/iu, "").trim();
  return preview ? preview.slice(0, 160) : null;
}

function cwdFromPayload(source: TraceSourceKind, payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const object = payload as Record<string, unknown>;
  if (source === "claude") return typeof object.cwd === "string" ? object.cwd : null;
  if (source === "codex") {
    const nested = object.payload;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const cwd = (nested as Record<string, unknown>).cwd;
      return typeof cwd === "string" ? cwd : null;
    }
  }
  return null;
}

function safeProjectHint(
  source: TraceSourceKind,
  events: readonly RawTraceEventInput[],
): string | null {
  for (const event of events) {
    const cwd = cwdFromPayload(source, event.payload);
    if (!cwd) continue;
    const hint = basename(cwd.trim());
    if (hint && hint !== "." && hint !== "/") return hint.slice(0, 120);
  }
  return null;
}

function latestActivity(events: readonly RawTraceEventInput[], fallback: string): string {
  let latest = Number.NEGATIVE_INFINITY;
  let latestIso = fallback;
  for (const event of events) {
    const timestamp = Date.parse(event.occurredAt);
    if (Number.isFinite(timestamp) && timestamp > latest && timestamp > 0) {
      latest = timestamp;
      latestIso = event.occurredAt;
    }
  }
  return latestIso;
}

/** Parse and fully preflight every logical trace before the caller writes one fact. */
export async function prepareSessionParts(
  source: TraceSourceKind,
  parts: readonly AdapterPart[],
  sourceIdentity: string,
  meta: SessionDescriptorMeta,
  adapter: TraceAdapter = createAdapter(source),
): Promise<PreparedTraceBundle[]> {
  const input = normalizeAdapterInput({ parts, sourceIdentity });
  const aggregateContentSha256 = sessionBundleContentSha256(input.parts);
  const events: PreparedTraceEvent[] = [];
  const warnings: PreparedSessionWarning[] = [];
  const artifacts = new Map<string, PreparedTraceArtifact>();
  const duplicateArtifactKeys = new Set<string>();

  for await (const record of adapter.parse(input)) {
    if (record.type === "warning") {
      warnings.push({ code: record.code, message: record.message });
      continue;
    }
    if (record.type === "event") {
      events.push({
        event: RawTraceEventInputSchema.parse(record.event),
        artifactKeys: [...new Set(record.artifactKeys ?? [])].sort(),
      });
      continue;
    }
    if (record.type === "artifact") {
      if (artifacts.has(record.key)) duplicateArtifactKeys.add(record.key);
      else artifacts.set(record.key, { ...record });
    }
  }
  if (events.length === 0) throw new Error("Session contains no importable visible events");

  const traceIds = [...new Set(events.map(({ event }) => event.traceId))].sort();
  return traceIds.map((traceId, traceIndex) => {
    const traceEvents = events.filter(({ event }) => event.traceId === traceId);
    const referencedKeys = new Set(traceEvents.flatMap(({ artifactKeys }) => artifactKeys));
    for (const key of referencedKeys) {
      if (duplicateArtifactKeys.has(key)) throw new Error(`Duplicate artifact key: ${key}`);
      if (!artifacts.has(key)) throw new Error(`Missing referenced artifact key: ${key}`);
    }
    const referencedArtifacts = [...referencedKeys].sort().map((key) => artifacts.get(key)!);
    const traceHash = createHash("sha256")
      .update("intenttrace-logical-trace-v1")
      .update("\0")
      .update(aggregateContentSha256)
      .update("\0")
      .update(traceId)
      .digest("hex");
    const rawEvents = traceEvents.map(({ event }) => event);
    const prompts = rawEvents.map(promptPreview).filter((value): value is string => value !== null);
    const title = rawEvents.find((event) => event.traceTitle)?.traceTitle ?? `${source} session`;
    const descriptor = SessionCatalogEntrySchema.parse({
      id:
        traceIds.length === 1
          ? meta.id
          : uploadSessionKey(source, `${aggregateContentSha256}:${traceId}:${traceIndex}`),
      source,
      title,
      projectHint: safeProjectHint(source, rawEvents),
      firstPromptPreview: prompts[0] ?? null,
      lastPromptPreview: prompts.at(-1) ?? null,
      lastActivityAt: latestActivity(rawEvents, meta.modifiedAt),
      byteLength: meta.byteLength,
      eventCount: rawEvents.length,
      warningCount: warnings.length,
      modifiedAt: meta.modifiedAt,
    });
    return {
      source,
      contentSha256: traceHash,
      aggregateContentSha256,
      events: traceEvents,
      artifacts: referencedArtifacts,
      warnings: [...warnings],
      descriptor,
      completionMarker: buildCompletionMarker(rawEvents.at(-1)!, traceHash),
    };
  });
}

/**
 * Catalog id for a session handed over as bytes rather than discovered on disk.
 * Domain-separated from the collector's path-derived `sessionCatalogId`, and
 * the same 24-hex shape so `SessionCatalogIdSchema` is unchanged.
 */
export function uploadSessionKey(source: TraceSourceKind, contentSha256: string): string {
  return createHash("sha256")
    .update("intenttrace-session-upload-v1")
    .update("\0")
    .update(source)
    .update("\0")
    .update(contentSha256)
    .digest("hex")
    .slice(0, 24);
}

/** Strips prompt text and the derived title unless the caller opted into previews. */
export function redactCatalogEntry(
  entry: SessionCatalogEntry,
  includePreviews: boolean,
): SessionCatalogEntry {
  if (includePreviews) return entry;
  return {
    ...entry,
    title: `${entry.source === "claude" ? "Claude" : entry.source === "codex" ? "Codex" : entry.source.toUpperCase()} session`,
    firstPromptPreview: null,
    lastPromptPreview: null,
  };
}

/**
 * The `trace_complete` marker closing an offline import. Its identity is
 * derived from the file's content hash, not from the transport, so a CLI import
 * and a browser upload of the same bytes are mutually idempotent.
 */
export function buildCompletionMarker(
  lastEvent: RawTraceEventInput,
  contentSha256: string,
): RawTraceEventInput {
  const completion = { ...lastEvent };
  delete completion.agentId;
  delete completion.spanId;
  delete completion.parentSpanId;
  delete completion.subjectId;
  delete completion.causationEventId;
  delete completion.payload;
  delete completion.payloadRef;
  return RawTraceEventInputSchema.parse({
    ...completion,
    source: {
      ...completion.source,
      sourceEventId: `import-complete-${contentSha256.slice(0, 32)}`,
    },
    kind: "trace_complete",
    name: "Offline import complete",
    status: "ok",
    artifactRefs: [],
    attributes: {
      collectorMarker: "offline_import_complete",
      contentSha256,
    },
  });
}

export type SessionFailureCode =
  | "preflight_failed"
  | "unsupported_version"
  | "no_visible_events"
  | "stale_session"
  | "file_too_large"
  | "unknown_source_format";

export function classifySessionFailure(error: unknown): {
  code: SessionFailureCode;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Session contains no importable visible events") {
    return { code: "no_visible_events", message };
  }
  if (message === "Session changed after discovery; refresh the catalog") {
    return { code: "stale_session", message };
  }
  if (message === "Session exceeds the configured file-size limit") {
    return { code: "file_too_large", message };
  }
  if (message === "Unable to determine the session format") {
    return { code: "unknown_source_format", message };
  }
  const unsupported = /Unsupported ([A-Za-z0-9_.:-]+) format version: ([A-Za-z0-9_.:-]+)/u.exec(
    message,
  );
  if (unsupported) {
    return {
      code: "unsupported_version",
      message: `Unsupported ${unsupported[1]} format version: ${unsupported[2]}`,
    };
  }
  // JSON parsers may quote source text in their native error. Never echo that
  // text from discovery/import diagnostics.
  return {
    code: "preflight_failed",
    message: "Session preflight failed; no events were imported",
  };
}
