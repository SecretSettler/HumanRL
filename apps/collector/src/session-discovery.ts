import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import type { ImportSourceKind } from "@intenttrace/schema";
import { discoverSessionCandidates } from "@intenttrace/adapters";

import type { ValidatedExplicitPath } from "./path-policy.js";

const TEXT_SESSION_EXTENSIONS = new Set([".jsonl", ".ndjson"]);

export interface SessionFilePart {
  id: string;
  filePath: string;
  relativePath: string;
  byteLength: number;
  modifiedAt: string;
  modifiedAtMs: number;
  fileIdentity: string;
}

export interface SessionFileCandidate {
  id: string;
  internalCandidateId: string;
  logicalRootIdentity: string;
  parts: SessionFilePart[];
  byteLength: number;
  modifiedAt: string;
  modifiedAtMs: number;
  normalizationIdentity: string;
}

export interface SessionFileDiscovery {
  candidates: SessionFileCandidate[];
  matchedFiles: number;
  skippedByLimit: number;
  unreadableDirectories: number;
  rejectedFiles: number;
  missingSessionIds: string[];
}

function portableRelativePath(root: ValidatedExplicitPath, filePath: string): string {
  if (root.kind === "file") return ".";
  return relative(root.realPath, filePath).split(sep).join("/");
}

/**
 * Catalog IDs are opaque capabilities scoped to the operator-named root. They
 * intentionally contain neither an absolute path nor a provider-native session ID.
 */
export function sessionCatalogId(
  source: ImportSourceKind,
  authorizedRoot: string,
  relativePath: string,
  byteLength: number,
  modifiedAtMs: number,
  fileIdentity: string,
): string {
  return createHash("sha256")
    .update("intenttrace-session-catalog-v1")
    .update("\0")
    .update(source)
    .update("\0")
    .update(authorizedRoot)
    .update("\0")
    .update(relativePath)
    .update("\0")
    .update(String(byteLength))
    .update("\0")
    .update(String(Math.trunc(modifiedAtMs)))
    .update("\0")
    .update(fileIdentity)
    .digest("hex")
    .slice(0, 24);
}

async function walkSessionFiles(
  source: ImportSourceKind,
  directory: string,
  onUnreadable: () => void,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    onUnreadable();
    return [];
  }

  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSessionFiles(source, child, onUnreadable)));
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    const accepted =
      source === "opencode"
        ? extension === ".db" ||
          entry.name.endsWith("-wal") ||
          entry.name.endsWith("-shm") ||
          extension === ".json"
        : source === "grok"
          ? extension === ".json" || TEXT_SESSION_EXTENSIONS.has(extension)
          : source === "omp"
            ? TEXT_SESSION_EXTENSIONS.has(extension) || extension === ".json"
            : source === "claude"
              ? TEXT_SESSION_EXTENSIONS.has(extension) || entry.name.endsWith(".meta.json")
              : source === "otlp"
                ? extension === ".json"
                : TEXT_SESSION_EXTENSIONS.has(extension);
    if (entry.isFile() && accepted) {
      files.push(child);
    }
  }
  return files;
}

export async function discoverSessionFiles(input: {
  source: ImportSourceKind;
  root: ValidatedExplicitPath;
  limit: number;
  newestFirst: boolean;
  selectedSessionIds?: ReadonlySet<string>;
}): Promise<SessionFileDiscovery> {
  let unreadableDirectories = 0;
  let rejectedFiles = 0;
  const files =
    input.root.kind === "file"
      ? [input.root.realPath]
      : await walkSessionFiles(input.source, input.root.realPath, () => {
          unreadableDirectories += 1;
        });

  const described: Array<SessionFilePart | null> = Array.from({ length: files.length }, () => null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(32, files.length) }, async () => {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      const filePath = files[index]!;
      try {
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink()) {
          rejectedFiles += 1;
          continue;
        }
        const resolvedFile = await realpath(filePath);
        if (input.root.kind === "directory") {
          const boundaryRelative = relative(input.root.realPath, resolvedFile);
          if (
            boundaryRelative === ".." ||
            boundaryRelative.startsWith(`..${sep}`) ||
            isAbsolute(boundaryRelative)
          ) {
            rejectedFiles += 1;
            continue;
          }
        }
        const relativePath = portableRelativePath(input.root, resolvedFile);
        described[index] = {
          id: sessionCatalogId(
            input.source,
            input.root.realPath,
            relativePath,
            info.size,
            info.mtimeMs,
            `${info.dev}:${info.ino}`,
          ),
          filePath: resolvedFile,
          relativePath,
          byteLength: info.size,
          modifiedAt: info.mtime.toISOString(),
          modifiedAtMs: info.mtimeMs,
          fileIdentity: `${info.dev}:${info.ino}`,
        };
      } catch {
        rejectedFiles += 1;
      }
    }
  });
  await Promise.all(workers);

  const fileParts = described.filter((part): part is SessionFilePart => part !== null);
  const discoveryParts = [];
  for (const part of fileParts) {
    const handle = await open(part.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        `${before.dev}:${before.ino}` !== part.fileIdentity ||
        before.size !== part.byteLength ||
        Math.trunc(before.mtimeMs) !== Math.trunc(part.modifiedAtMs)
      ) {
        throw new Error("Session changed after discovery; refresh the catalog");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        `${after.dev}:${after.ino}` !== part.fileIdentity ||
        after.size !== part.byteLength ||
        Math.trunc(after.mtimeMs) !== Math.trunc(part.modifiedAtMs)
      ) {
        throw new Error("Session changed after discovery; refresh the catalog");
      }
      discoveryParts.push({
        clientRef: part.id,
        path: part.relativePath,
        byteLength: part.byteLength,
        modifiedAt: part.modifiedAt,
        bytes,
        complete: true,
      });
    } finally {
      await handle.close();
    }
  }
  const grouped = await discoverSessionCandidates(input.source, discoveryParts, 50);
  const byPartId = new Map(fileParts.map((part) => [part.id, part]));
  const candidates = grouped.map((candidate) => {
    const parts = candidate.partRefs.map((ref) => byPartId.get(ref)!);
    const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
    const modifiedAtMs = Math.max(...parts.map((part) => part.modifiedAtMs));
    const publicId = sessionCatalogId(
      input.source,
      input.root.realPath,
      parts
        .map((part) => part.relativePath)
        .sort()
        .join("\0"),
      byteLength,
      modifiedAtMs,
      parts
        .map((part) => part.fileIdentity)
        .sort()
        .join("\0"),
    );
    return {
      id: publicId,
      internalCandidateId: candidate.candidateId,
      logicalRootIdentity: candidate.rootIdentity,
      parts,
      byteLength,
      modifiedAt: new Date(modifiedAtMs).toISOString(),
      modifiedAtMs,
      normalizationIdentity: `bundle-${publicId}`,
    };
  });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const missingSessionIds = input.selectedSessionIds
    ? [...input.selectedSessionIds].filter((id) => !byId.has(id)).sort()
    : [];
  const selected = input.selectedSessionIds
    ? candidates.filter((candidate) => input.selectedSessionIds!.has(candidate.id))
    : candidates;
  const ordered = selected.sort((left, right) =>
    input.newestFirst
      ? right.modifiedAtMs - left.modifiedAtMs || left.id.localeCompare(right.id)
      : left.parts[0]!.relativePath.localeCompare(right.parts[0]!.relativePath),
  );

  return {
    candidates: ordered.slice(0, input.limit),
    matchedFiles: files.length,
    unreadableDirectories,
    rejectedFiles,
    skippedByLimit: Math.max(0, candidates.length - input.limit),
    missingSessionIds,
  };
}
