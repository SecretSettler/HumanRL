import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  RawTraceEventInputSchema,
  SchemaVersion,
  type RawEventKind,
  type RawTraceEventInput,
  type TraceSourceKind,
} from "@intenttrace/schema";

export function stableUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function updateLength(hash: ReturnType<typeof createHash>, length: number): void {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(length));
  hash.update(bytes);
}

/** Stable aggregate identity without concatenating complete session bytes. */
export function sessionBundleContentSha256(
  parts: readonly { path: string; bytes: Uint8Array }[],
): string {
  const normalized = [...parts]
    .map((part) => {
      if (
        part.path.length === 0 ||
        part.path.includes("\0") ||
        part.path.includes("\\") ||
        part.path.startsWith("/") ||
        /^[A-Za-z]:/u.test(part.path)
      ) {
        throw new Error("Invalid session part path");
      }
      const segments = part.path.split("/");
      if (segments.includes("..")) throw new Error("Invalid session part path");
      return {
        path: segments.filter((segment) => segment !== "" && segment !== ".").join("/") || ".",
        bytes: part.bytes,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const paths = new Set<string>();
  const hash = createHash("sha256").update("intenttrace-session-bundle-v1").update("\0");
  for (const part of normalized) {
    if (paths.has(part.path)) throw new Error(`Duplicate session part path: ${part.path}`);
    paths.add(part.path);
    const pathBytes = new TextEncoder().encode(part.path);
    updateLength(hash, pathBytes.byteLength);
    hash.update(pathBytes);
    updateLength(hash, part.bytes.byteLength);
    hash.update(part.bytes);
  }
  return hash.digest("hex");
}

export function decodeAdapterBytes(bytes: Uint8Array): string {
  const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
}

/** One parsed record from a session file, in source order. */
export interface SessionRecord {
  /** 1-based record index; doubles as the fallback `sourceEventId` suffix. */
  line: number;
  value: unknown;
  bytes: Uint8Array;
}

export function readSessionRecords(text: string): SessionRecord[] {
  const encoder = new TextEncoder();
  const expand = (values: readonly unknown[]) =>
    values.map((value, index) => ({
      line: index + 1,
      value,
      bytes: encoder.encode(JSON.stringify(value)),
    }));

  let lineError: unknown;
  try {
    const lines = parseJsonLines(text);
    // A minified top-level array parses as one line holding one array value.
    if (lines.length === 1 && Array.isArray(lines[0]!.value)) return expand(lines[0]!.value);
    return lines;
  } catch (error) {
    lineError = error;
  }
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    throw lineError;
  }
  return Array.isArray(document) ? expand(document) : expand([document]);
}

function parseJsonLines(text: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    if (!raw.trim()) continue;
    records.push({
      line: index + 1,
      value: JSON.parse(raw) as unknown,
      bytes: new TextEncoder().encode(raw),
    });
  }
  return records;
}

export interface NormalizedContext {
  source: TraceSourceKind;
  formatVersion: string;
  adapterVersion: string;
  sourceIdentity: string;
  sessionId: string;
  line: number;
}

export function normalizeEvent(
  context: NormalizedContext,
  input: {
    sourceEventId?: string | undefined;
    occurredAt?: string | undefined;
    kind: RawEventKind;
    name: string;
    status?: "unset" | "ok" | "error";
    agentId?: string | undefined;
    spanId?: string | undefined;
    parentSpanId?: string | undefined;
    subjectId?: string | undefined;
    attributes?: Record<string, unknown> | undefined;
    payload?: unknown | undefined;
    traceTitle?: string | undefined;
  },
): RawTraceEventInput {
  const sourceInstanceId = safeIdentifier(
    context.sourceIdentity,
    `source-${stableUuid("source", context.sourceIdentity)}`,
  );
  const sourceEventId = safeIdentifier(
    input.sourceEventId ?? `${context.sessionId}-${context.line}`,
    `event-${context.line}`,
  );
  const traceId = stableUuid("intenttrace-trace", `${context.source}:${context.sessionId}`);
  return RawTraceEventInputSchema.parse({
    schemaVersion: SchemaVersion,
    workspaceId: stableUuid("intenttrace-workspace", "local"),
    projectId: stableUuid("intenttrace-project", context.sourceIdentity),
    traceId,
    workspaceName: "Local workspace",
    projectName: context.sourceIdentity,
    traceTitle: input.traceTitle ?? `${context.source} session ${context.sessionId}`,
    source: {
      kind: context.source,
      formatVersion: context.formatVersion,
      adapterVersion: context.adapterVersion,
      sourceInstanceId,
      sourceEventId,
    },
    occurredAt: normalizeTimestamp(input.occurredAt),
    kind: input.kind,
    name: input.name.slice(0, 240),
    status: input.status ?? "unset",
    ...(input.agentId ? { agentId: safeIdentifier(input.agentId, "agent") } : {}),
    ...(input.spanId ? { spanId: safeIdentifier(input.spanId, "span") } : {}),
    ...(input.parentSpanId
      ? { parentSpanId: safeIdentifier(input.parentSpanId, "parent-span") }
      : {}),
    ...(input.subjectId ? { subjectId: safeIdentifier(input.subjectId, "subject") } : {}),
    artifactRefs: [],
    attributes: input.attributes ?? {},
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
}

export function normalizeTimestamp(value?: string): string {
  if (!value) return new Date(0).toISOString();
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? new Date(0).toISOString() : timestamp.toISOString();
}

export function safeIdentifier(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/gu, "-").slice(0, 128);
  return normalized && /^[A-Za-z0-9_.:-]+$/u.test(normalized) ? normalized : fallback;
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const object = objectRecord(item);
        if (object) {
          if (typeof object.text === "string") return object.text;
          if (object.content !== undefined) return visibleText(object.content);
          if (object.output !== undefined) return visibleText(object.output);
        }
        return visibleText(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

export function displayPreview(value: unknown, limit = 200): string {
  const normalized = visibleText(value).replaceAll(/\s+/gu, " ").trim();
  return normalized.slice(0, limit);
}

export function displayName(label: string, value?: unknown): string {
  const preview = value === undefined ? "" : displayPreview(value);
  return preview ? `${label} · ${preview}` : label;
}

const reasoningKeys = new Set([
  "reasoning",
  "thinking",
  "thinkingSignature",
  "thinking_signature",
  "signature",
  "redacted_thinking",
  "agent_thought_chunk",
]);
const confidentialKeys = new Set([
  "encrypted_content",
  "base_instructions",
  "systemPrompt",
  "system_prompt",
  "prompt_body",
]);
const pathKeys = new Set(["cwd", "child_cwd", "grok_home", "directory", "homeDir", "resolvedPath"]);
const usernameKeys = new Set(["username", "user_name", "userName"]);
const reasoningBlockTypes = new Set(["thinking", "redacted_thinking", "agent_thought_chunk"]);
const confidentialBlockTypes = new Set(["encrypted_content"]);
const hostPathPattern = /(?:\/home\/[^\s"'\\/]+|\/Users\/[^\s"'\\/]+)/gu;
const ciphertextPattern = /gAAAA[A-Za-z0-9_=-]{4,}/gu;

export interface VendorSanitizeResult {
  value: unknown;
  reasoning: number;
  confidential: number;
}

/** Shared vendor-record redaction: hidden reasoning, encrypted bodies, and host paths. */
export function sanitizeVendorValue(value: unknown): VendorSanitizeResult {
  if (typeof value === "string") {
    let confidential = 0;
    let output = value;
    if (ciphertextPattern.test(output)) {
      ciphertextPattern.lastIndex = 0;
      output = output.replaceAll(ciphertextPattern, "[encrypted content omitted]");
      confidential += 1;
    }
    ciphertextPattern.lastIndex = 0;
    if (hostPathPattern.test(output)) {
      hostPathPattern.lastIndex = 0;
      output = output.replaceAll(hostPathPattern, "~");
      confidential += 1;
    }
    hostPathPattern.lastIndex = 0;
    return { value: output, reasoning: 0, confidential };
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let reasoning = 0;
    let confidential = 0;
    for (const item of value) {
      const object = objectRecord(item);
      const blockType = object ? String(object.type ?? "") : "";
      if (reasoningBlockTypes.has(blockType)) {
        reasoning += 1;
        continue;
      }
      if (confidentialBlockTypes.has(blockType)) {
        confidential += 1;
        continue;
      }
      const sanitized = sanitizeVendorValue(item);
      output.push(sanitized.value);
      reasoning += sanitized.reasoning;
      confidential += sanitized.confidential;
    }
    return { value: output, reasoning, confidential };
  }
  const object = objectRecord(value);
  if (!object) return { value, reasoning: 0, confidential: 0 };
  if (
    object.type === "thinking" ||
    object.type === "redacted_thinking" ||
    object.type === "reasoning" ||
    object.type === "agent_thought_chunk"
  ) {
    return { value: { type: object.type }, reasoning: 1, confidential: 0 };
  }
  if (object.type === "encrypted_content") {
    return { value: { type: object.type }, reasoning: 0, confidential: 1 };
  }
  const output: Record<string, unknown> = {};
  let reasoning = 0;
  let confidential = 0;
  for (const [key, item] of Object.entries(object)) {
    if (reasoningKeys.has(key)) {
      reasoning += 1;
      continue;
    }
    if (confidentialKeys.has(key)) {
      confidential += 1;
      continue;
    }
    if (usernameKeys.has(key)) {
      confidential += 1;
      continue;
    }
    if (pathKeys.has(key) && typeof item === "string" && item.includes("/")) {
      output[key] = item.split("/").filter(Boolean).at(-1) ?? "";
      confidential += 1;
      continue;
    }
    const sanitized = sanitizeVendorValue(item);
    output[key] = sanitized.value;
    reasoning += sanitized.reasoning;
    confidential += sanitized.confidential;
  }
  return { value: output, reasoning, confidential };
}
