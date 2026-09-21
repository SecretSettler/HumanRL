import type { RawTraceEventInput, TopologyCapability, TraceSourceKind } from "@intenttrace/schema";

export const topologyAttributeKeys = [
  "parentAgentId",
  "spawnedAgentIds",
  "joinedAgentIds",
  "joinedBy",
  "senderAgentId",
  "recipientAgentId",
  "messageId",
  "onBehalfOf",
  "assignedBy",
  "topologyProvenance",
] as const;

export type TopologyAttributeKey = (typeof topologyAttributeKeys)[number];

export interface CanonicalTopologyAttributes {
  parentAgentId?: string;
  spawnedAgentIds?: readonly string[];
  joinedAgentIds?: readonly string[];
  joinedBy?: string;
  senderAgentId?: string;
  recipientAgentId?: string;
  messageId?: string;
  onBehalfOf?: string;
  assignedBy?: string;
  topologyProvenance?: "stated" | "inferred";
}

export interface AdapterManifest {
  source: TraceSourceKind;
  adapterVersion: string;
  supportedFormatVersions: readonly string[];
  status: "implemented";
  topology: TopologyCapability;
}

export interface AdapterPart {
  path: string;
  bytes: Uint8Array;
}

export interface AdapterInput {
  parts: readonly AdapterPart[];
  sourceIdentity: string;
}

export type AdapterRecord =
  | { type: "event"; event: RawTraceEventInput; artifactKeys?: readonly string[] }
  | {
      type: "artifact";
      key: string;
      sourceEventId: string;
      bytes: Uint8Array;
      mediaType: string;
    }
  | { type: "warning"; code: string; message: string; sourceEventId?: string }
  | { type: "checkpoint"; sourceIdentity: string; offset: number; prefixHash: string };

export interface TraceAdapter {
  readonly manifest: AdapterManifest;
  sniff(input: AdapterInput): Promise<boolean>;
  parse(input: AdapterInput): AsyncIterable<AdapterRecord>;
}

function normalizePartPath(path: string): string {
  if (path.length === 0) throw new Error("Adapter part path must not be empty");
  if (path.includes("\0")) throw new Error("Adapter part path must not contain NUL");
  if (path.includes("\\")) throw new Error("Adapter part path must use POSIX separators");
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) {
    throw new Error("Adapter part path must be relative");
  }
  const segments = path.split("/");
  if (segments.includes("..")) throw new Error("Adapter part path must not contain '..'");
  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  if (normalized.length === 0 && path !== ".") {
    throw new Error("Adapter part path must identify a file or use '.'");
  }
  return normalized || ".";
}

export function normalizeAdapterInput(input: AdapterInput): AdapterInput {
  if (input.parts.length === 0) throw new Error("Adapter input must contain at least one part");
  const paths = new Set<string>();
  const parts = input.parts
    .map((part) => ({ path: normalizePartPath(part.path), bytes: part.bytes }))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const part of parts) {
    if (paths.has(part.path)) throw new Error(`Duplicate adapter part path: ${part.path}`);
    paths.add(part.path);
  }
  return { parts, sourceIdentity: input.sourceIdentity };
}

export function singleAdapterPart(input: AdapterInput): AdapterPart {
  const normalized = normalizeAdapterInput(input);
  if (normalized.parts.length !== 1) {
    throw new Error(`Expected exactly one adapter part, received ${normalized.parts.length}`);
  }
  return normalized.parts[0]!;
}

export class UnsupportedAdapterVersionError extends Error {
  readonly code = "unsupported_adapter_version";

  constructor(source: TraceSourceKind, formatVersion: string) {
    super(`Unsupported ${source} format version: ${formatVersion}`);
    this.name = "UnsupportedAdapterVersionError";
  }
}

export class MalformedAdapterInputError extends Error {
  readonly code = "malformed_adapter_input";

  constructor(source: TraceSourceKind, detail: string) {
    super(`Malformed ${source} input: ${detail}`);
    this.name = "MalformedAdapterInputError";
  }
}
