import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  prepareSessionParts,
  sessionBundleContentSha256,
  type PreparedSessionWarning,
} from "@intenttrace/adapters";
import type { RawTraceEventInput, SessionCatalogEntry, TraceSourceKind } from "@intenttrace/schema";

import type { SessionFileCandidate } from "./session-discovery.js";

export type { PreparedSessionWarning };

export interface PreparedSession {
  candidate: SessionFileCandidate;
  contentSha256: string;
  parts: Array<{ path: string; bytes: Uint8Array; clientRef: string; modifiedAt: string }>;
  events: RawTraceEventInput[];
  warnings: PreparedSessionWarning[];
  descriptor: SessionDescriptor;
  completionMarker: RawTraceEventInput;
  logicalIndex: number;
  logicalCount: number;
}

export type SessionDescriptor = SessionCatalogEntry;

/**
 * Parse and validate the complete source before the caller sends its first raw
 * fact. This prevents a malformed tail from leaving a partially imported trace.
 */
export async function prepareSession(
  source: TraceSourceKind,
  candidate: SessionFileCandidate,
  maxFileBytes: number,
): Promise<PreparedSession[]> {
  if (candidate.byteLength > maxFileBytes) {
    throw new Error("Session exceeds the configured file-size limit");
  }
  const parts: PreparedSession["parts"] = [];
  for (const part of candidate.parts) {
    const handle = await open(part.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        `${info.dev}:${info.ino}` !== part.fileIdentity ||
        info.size !== part.byteLength ||
        Math.trunc(info.mtimeMs) !== Math.trunc(part.modifiedAtMs)
      ) {
        throw new Error("Session changed after discovery; refresh the catalog");
      }
      const bytes = await handle.readFile();
      const afterRead = await handle.stat();
      if (
        `${afterRead.dev}:${afterRead.ino}` !== part.fileIdentity ||
        afterRead.size !== part.byteLength ||
        Math.trunc(afterRead.mtimeMs) !== Math.trunc(part.modifiedAtMs)
      ) {
        throw new Error("Session changed after discovery; refresh the catalog");
      }
      parts.push({
        path: part.relativePath,
        bytes,
        clientRef: part.id,
        modifiedAt: part.modifiedAt,
      });
    } finally {
      await handle.close();
    }
  }
  const aggregateContentSha256 = sessionBundleContentSha256(parts);
  const sourceIdentity = `bundle-${aggregateContentSha256.slice(0, 32)}`;
  const prepared = await prepareSessionParts(source, parts, sourceIdentity, {
    id: candidate.id,
    byteLength: candidate.byteLength,
    modifiedAt: candidate.modifiedAt,
  });
  return prepared.map((trace, logicalIndex) => ({
    candidate,
    parts,
    contentSha256: trace.contentSha256,
    events: trace.events.map(({ event }) => event),
    warnings: trace.warnings,
    descriptor: trace.descriptor,
    completionMarker: trace.completionMarker,
    logicalIndex,
    logicalCount: prepared.length,
  }));
}
