import { createHash } from "node:crypto";
import { dirname, extname } from "node:path/posix";

import type { ImportSourceKind } from "@intenttrace/schema";

import { decodeAdapterBytes, objectRecord, readSessionRecords } from "./common.js";

export interface SessionDiscoveryPart {
  clientRef: string;
  path: string;
  byteLength: number;
  modifiedAt: string;
  bytes: Uint8Array;
  complete: boolean;
}

export interface DiscoveredSessionCandidate {
  clientRef: string;
  candidateId: string;
  partRefs: string[];
  source: ImportSourceKind;
  rootIdentity: string;
  failureCode: "preflight_failed" | null;
  failureMessage: string | null;
}

export function computeSessionCandidateId(
  source: ImportSourceKind,
  rootIdentity: string,
  paths: readonly string[],
): string {
  const hash = createHash("sha256")
    .update("intenttrace-session-candidate-v2")
    .update("\0")
    .update(source)
    .update("\0")
    .update(rootIdentity);
  for (const path of [...paths].sort()) hash.update("\0").update(path);
  return hash.digest("hex").slice(0, 24);
}

export function logicalSessionRootIdentity(
  rootIdentity: string,
  index: number,
  total: number,
): string {
  return total === 1 ? rootIdentity : `${rootIdentity}:logical-${index + 1}`;
}

function completedCandidate(
  source: ImportSourceKind,
  rootIdentity: string,
  parts: readonly SessionDiscoveryPart[],
  failureMessage: string | null = null,
): DiscoveredSessionCandidate {
  const ordered = [...parts].sort((left, right) => left.path.localeCompare(right.path));
  return {
    clientRef: ordered[0]!.clientRef,
    candidateId: computeSessionCandidateId(
      source,
      rootIdentity,
      ordered.map((part) => part.path),
    ),
    partRefs: ordered.map((part) => part.clientRef),
    source,
    rootIdentity,
    failureCode: failureMessage ? "preflight_failed" : null,
    failureMessage,
  };
}

function jsonObject(part: SessionDiscoveryPart): Record<string, unknown> | null {
  try {
    return objectRecord(readSessionRecords(decodeAdapterBytes(part.bytes))[0]?.value);
  } catch {
    return null;
  }
}

export async function discoverSessionCandidates(
  source: ImportSourceKind,
  inputParts: readonly SessionDiscoveryPart[],
  maxCandidates = 50,
): Promise<DiscoveredSessionCandidate[]> {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 50) {
    throw new Error("Session candidate root limit must be between 1 and 50");
  }
  const parts = [...inputParts].sort((left, right) => left.path.localeCompare(right.path));
  if (source === "jsonl" || source === "otlp") {
    return parts
      .slice(0, maxCandidates)
      .map((part) => completedCandidate(source, part.path, [part]));
  }
  if (source === "opencode") {
    const databaseParts = parts.filter((part) =>
      /(?:^|\/)opencode\.db(?:-(?:wal|shm))?$/u.test(part.path),
    );
    if (databaseParts.length === 0) return [];
    const failure = databaseParts.some((part) => !part.complete)
      ? "OpenCode candidate inspection requires complete database and WAL bytes"
      : null;
    return [completedCandidate(source, "opencode-root", databaseParts, failure)];
  }
  if (source === "claude") {
    const roots = parts
      .filter(
        (part) =>
          /\.(?:jsonl|ndjson)$/iu.test(part.path) &&
          !part.path.includes("/subagents/") &&
          !part.path.startsWith("subagents/"),
      )
      .slice(0, maxCandidates);
    return roots.map((root) => {
      const object = jsonObject(root);
      const rootIdentity = String(object?.sessionId ?? object?.session_id ?? root.path);
      const companions = parts.filter((part) => {
        if (!part.path.includes("/subagents/") && !part.path.startsWith("subagents/")) return false;
        const candidate = jsonObject(part);
        return (
          candidate !== null &&
          String(candidate.sessionId ?? candidate.session_id ?? "") === rootIdentity
        );
      });
      return completedCandidate(source, rootIdentity, [root, ...companions]);
    });
  }
  if (source === "omp") {
    const roots = parts
      .filter((part) => /\.(?:jsonl|ndjson)$/iu.test(part.path) && dirname(part.path) === ".")
      .slice(0, maxCandidates);
    return roots.map((root) => {
      const stem = root.path.slice(0, -extname(root.path).length);
      const companions = parts.filter((part) => part.path.startsWith(`${stem}/`));
      const object = jsonObject(root);
      const expectsCompanions = Array.isArray(objectRecord(object?.details)?.progress);
      return completedCandidate(
        source,
        stem,
        [root, ...companions],
        expectsCompanions && companions.length === 0
          ? "OMP candidate requires its same-stem companion directory"
          : null,
      );
    });
  }
  if (source === "codex") {
    const identities = new Map<string, { part: SessionDiscoveryPart; parent: string | null }>();
    for (const part of parts) {
      const object = jsonObject(part);
      const payload = objectRecord(object?.payload);
      const id = String(payload?.id ?? part.path);
      const parent = typeof payload?.forked_from_id === "string" ? payload.forked_from_id : null;
      identities.set(id, { part, parent });
    }
    const rootFor = (id: string): string => {
      const seen = new Set<string>();
      let current = id;
      while (!seen.has(current)) {
        seen.add(current);
        const parent = identities.get(current)?.parent;
        if (!parent || !identities.has(parent)) return current;
        current = parent;
      }
      return current;
    };
    const groups = new Map<string, SessionDiscoveryPart[]>();
    for (const [id, entry] of identities) {
      const root = rootFor(id);
      const group = groups.get(root) ?? [];
      group.push(entry.part);
      groups.set(root, group);
    }
    return [...groups.entries()]
      .sort()
      .slice(0, maxCandidates)
      .map(([root, group]) => completedCandidate(source, root, group));
  }
  const roots = new Map<string, SessionDiscoveryPart[]>();
  for (const part of parts) {
    const object = jsonObject(part);
    const root = String(
      object?.parent_session_id ?? object?.resumed_from ?? object?.session_id ?? dirname(part.path),
    );
    const group = roots.get(root) ?? [];
    group.push(part);
    roots.set(root, group);
  }
  return [...roots.entries()]
    .sort()
    .slice(0, maxCandidates)
    .map(([root, group]) => completedCandidate(source, root, group));
}
