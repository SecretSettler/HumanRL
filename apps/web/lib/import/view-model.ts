import type { TraceSourceKind } from "@intenttrace/schema";

/** Matches the collector's DEFAULT_DISCOVER_LIMIT. */
export const CANDIDATE_WINDOW = 50;
/** Head window sent to `/imports/candidates`; the request cap is 128 KiB base64. */
export const HEAD_BYTES = 64 * 1024;
export const UPLOAD_CONCURRENCY = 2;
export const ALL_SOURCES = "__all__";

const FOLDER_EXTENSIONS = [".jsonl", ".ndjson", ".meta.json", ".db", "-wal", "-shm"];
const FILE_EXTENSIONS = [".jsonl", ".ndjson", ".json", ".db", "-wal", "-shm"];

export type ImportRowStatus =
  "inspecting" | "ready" | "queued" | "uploading" | "imported" | "failed";

export interface ImportPart {
  clientRef: string;
  path: string;
  file: File;
}

export interface ImportRow {
  clientRef: string;
  key: string;
  file: File;
  path: string;
  name: string;
  size: number;
  lastModified: number;
  status: ImportRowStatus;
  selected: boolean;
  source: TraceSourceKind | null;
  candidateId: string | null;
  partRefs: string[];
  title: string | null;
  projectHint: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  partialHead: boolean;
  imported: boolean;
  traceId: string | null;
  inserted: number;
  duplicates: number;
  failureCode: string | null;
  failureMessage: string | null;
  failureStage: "inspect" | "upload" | null;
}

export interface CandidateFile {
  name: string;
  size: number;
  lastModified: number;
}

export function dedupeKey(file: CandidateFile): string {
  return `${file.name}\0${file.size}\0${file.lastModified}`;
}

export function fileRelativePath(file: File, mode: "folder" | "files"): string {
  return mode === "folder" && file.webkitRelativePath ? file.webkitRelativePath : file.name;
}

export interface SelectedBundleGroup {
  key: string;
  source: TraceSourceKind | "auto";
  candidateIds: string[];
  parts: ImportPart[];
  rowRefs: string[];
}

export interface BundleGroupingResult {
  groups: SelectedBundleGroup[];
  failures: Array<{ rowRefs: string[]; message: string }>;
}

export function groupSelectedBundles(
  rows: readonly ImportRow[],
  partRows: readonly ImportRow[] = rows,
): BundleGroupingResult {
  const groups = new Map<string, SelectedBundleGroup>();
  const failures: BundleGroupingResult["failures"] = [];
  const byRef = new Map(partRows.map((row) => [row.clientRef, row]));
  for (const row of rows) {
    if (!row.candidateId) continue;
    const refs = [...new Set(row.partRefs)].sort();
    const key = refs.join("\0");
    const existing = groups.get(key);
    if (existing) {
      existing.candidateIds.push(row.candidateId);
      existing.rowRefs.push(row.clientRef);
      continue;
    }
    const missing = refs.find((ref) => !byRef.has(ref));
    if (missing) {
      failures.push({ rowRefs: [row.clientRef], message: `Missing selected part ${missing}` });
      continue;
    }
    const parts = refs.map((ref) => {
      const part = byRef.get(ref)!;
      return { clientRef: ref, path: part.path, file: part.file };
    });
    groups.set(key, {
      key,
      source: row.source ?? "auto",
      candidateIds: [row.candidateId],
      parts,
      rowRefs: [row.clientRef],
    });
  }
  return {
    groups: [...groups.values()].map((group) => ({
      ...group,
      candidateIds: [...new Set(group.candidateIds)].sort(),
      rowRefs: [...new Set(group.rowRefs)].sort(),
    })),
    failures,
  };
}

interface CandidateResponseRow {
  clientRef: string;
  candidateId: string;
  partRefs: string[];
  source: TraceSourceKind | null;
  title: string | null;
  projectHint: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  partialHead: boolean;
  traceId: string | null;
  imported: boolean;
  failureCode: string | null;
  importedEventCount: string | null;
  failureMessage: string | null;
}

export function candidateRowsFromResponse(
  partRows: readonly ImportRow[],
  candidates: readonly CandidateResponseRow[],
): ImportRow[] {
  const byPart = new Map(partRows.map((row) => [row.clientRef, row]));
  return candidates.flatMap((candidate) => {
    const sourceRef = candidate.partRefs[0];
    const source = sourceRef ? byPart.get(sourceRef) : undefined;
    if (!source) return [];
    return [
      {
        ...source,
        clientRef: candidate.clientRef,
        key: `${source.key}\0${candidate.candidateId}`,
        status: candidate.failureCode ? "failed" : "ready",
        candidateId: candidate.candidateId,
        partRefs: [...candidate.partRefs],
        source: candidate.source,
        title: candidate.title,
        projectHint: candidate.projectHint,
        firstPromptPreview: candidate.firstPromptPreview,
        lastPromptPreview: candidate.lastPromptPreview,
        partialHead: candidate.partialHead,
        imported: candidate.imported,
        traceId: candidate.traceId,
        failureCode: candidate.failureCode,
        failureMessage: candidate.failureMessage,
        failureStage: candidate.failureCode ? "inspect" : null,
      },
    ];
  });
}

export async function buildSessionBundleFrame(
  inputParts: readonly ImportPart[],
  source: TraceSourceKind | "auto",
  candidateIds: readonly string[],
): Promise<Blob> {
  const parts = [...inputParts].sort((left, right) => left.path.localeCompare(right.path));
  let offset = 0;
  const manifest = {
    protocolVersion: 1,
    source,
    candidateIds: [...candidateIds],
    parts: parts.map((part) => {
      const entry = {
        clientRef: part.clientRef,
        path: part.path,
        offset,
        byteLength: part.file.size,
        modifiedAt: new Date(part.file.lastModified).toISOString(),
      };
      offset += part.file.size;
      return entry;
    }),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new ArrayBuffer(8);
  const headerBytes = new Uint8Array(header);
  headerBytes.set(new TextEncoder().encode("ITB1"));
  new DataView(header).setUint32(4, manifestBytes.byteLength);
  return new Blob([headerBytes, manifestBytes, ...parts.map((part) => part.file)], {
    type: "application/vnd.intenttrace.session-bundle",
  });
}

export interface RankedCandidates {
  window: File[];
  skippedByLimit: number;
  ignored: number;
}

/**
 * Folder mode mirrors the collector's directory walk and keeps only line-delimited
 * files, so Claude's `sessions-index.json` metadata never enters the catalog. An
 * explicit file pick is an operator decision, so whole-document `.json` is allowed.
 */
export function rankCandidates(files: readonly File[], mode: "folder" | "files"): RankedCandidates {
  const allowed = mode === "folder" ? FOLDER_EXTENSIONS : FILE_EXTENSIONS;
  const kept: File[] = [];
  const seen = new Set<string>();
  let ignored = 0;
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (!allowed.some((extension) => name.endsWith(extension))) {
      ignored += 1;
      continue;
    }
    const key = dedupeKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(file);
  }
  kept.sort((left, right) =>
    right.lastModified === left.lastModified
      ? left.name.localeCompare(right.name)
      : right.lastModified - left.lastModified,
  );
  const pathOf = (file: File) => file.webkitRelativePath || file.name;
  const isExplicitCompanion = (file: File) => {
    const path = pathOf(file);
    return (
      path.includes("/subagents/") ||
      file.name.endsWith(".meta.json") ||
      file.name.endsWith("-wal") ||
      file.name.endsWith("-shm")
    );
  };
  const jsonCandidates = kept.filter(
    (file) => !isExplicitCompanion(file) && /\.(?:jsonl|ndjson)$/iu.test(file.name),
  );
  const candidateStems = new Set(
    jsonCandidates.map((file) => {
      const path = pathOf(file);
      return path.slice(0, path.lastIndexOf("."));
    }),
  );
  const isNestedJson = (file: File) => {
    const path = pathOf(file);
    return [...candidateStems].some((stem) => path.startsWith(`${stem}/`));
  };
  const roots = kept.filter((file) => !isExplicitCompanion(file) && !isNestedJson(file));
  const selectedRoots = roots.slice(0, CANDIDATE_WINDOW);
  const selectedPaths = selectedRoots.map(pathOf);
  const selectedStems = new Set(selectedPaths.map((path) => path.slice(0, path.lastIndexOf("."))));
  const selectedDirectories = new Set(
    selectedPaths.map((path) => path.slice(0, Math.max(0, path.lastIndexOf("/")))),
  );
  const selectedDatabasePaths = new Set(selectedPaths.filter((path) => path.endsWith(".db")));
  const companions = kept.filter((file) => {
    const path = pathOf(file);
    if (
      path.includes("/subagents/") ||
      path.startsWith("subagents/") ||
      file.name.endsWith(".meta.json")
    ) {
      const projectDirectory = path.includes("/subagents/")
        ? path.slice(0, path.indexOf("/subagents/"))
        : path.startsWith("subagents/")
          ? ""
          : path.slice(0, Math.max(0, path.lastIndexOf("/")));
      return selectedDirectories.has(projectDirectory);
    }
    if (file.name.endsWith("-wal") || file.name.endsWith("-shm")) {
      const databasePath = path.replace(/-(?:wal|shm)$/u, "");
      return selectedDatabasePaths.has(databasePath);
    }
    if (!isNestedJson(file)) return false;
    return [...selectedStems].some((stem) => path.startsWith(`${stem}/`));
  });
  return {
    window: [...selectedRoots, ...companions],
    skippedByLimit: Math.max(0, roots.length - CANDIDATE_WINDOW),
    ignored,
  };
}

export interface RowFilter {
  query: string;
  source: string;
  hideImported: boolean;
}

/** Matches file name and title only — prompt previews are never searched. */
export function visibleRows(rows: readonly ImportRow[], filter: RowFilter): ImportRow[] {
  const needle = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.hideImported && row.imported) return false;
    if (filter.source !== ALL_SOURCES && row.source !== filter.source) return false;
    if (!needle) return true;
    return (
      row.name.toLowerCase().includes(needle) ||
      (row.title?.toLowerCase().includes(needle) ?? false)
    );
  });
}

export interface EmptyStateInput {
  isInspecting: boolean;
  allInspectFailed: boolean;
  settled: boolean;
  visibleCount: number;
  totalCount: number;
  alreadyImportedCount: number;
  isFiltered: boolean;
}

export function computeEmptyState(input: EmptyStateInput): { show: boolean; title: string } {
  const hidden = { show: false, title: "" };
  if (input.isInspecting) return hidden;
  // The error banner owns the surface when nothing could be inspected.
  if (input.allInspectFailed) return hidden;
  if (!input.settled) return hidden;
  if (input.visibleCount > 0) return hidden;
  if (input.isFiltered && input.totalCount > 0) {
    return { show: true, title: "当前筛选没有匹配的会话。" };
  }
  if (input.alreadyImportedCount > 0 && input.alreadyImportedCount === input.totalCount) {
    return { show: true, title: "所选会话都已经导入过。" };
  }
  return { show: true, title: "没有可导入的会话。" };
}

export interface ImportSummary {
  selected: number;
  imported: number;
  failed: number;
  inserted: number;
  duplicates: number;
}

export function summarize(rows: readonly ImportRow[]): ImportSummary {
  const summary: ImportSummary = {
    selected: 0,
    imported: 0,
    failed: 0,
    inserted: 0,
    duplicates: 0,
  };
  for (const row of rows) {
    if (row.selected) summary.selected += 1;
    if (row.status === "imported") summary.imported += 1;
    if (row.status === "failed") summary.failed += 1;
    summary.inserted += row.inserted;
    summary.duplicates += row.duplicates;
  }
  return summary;
}

export function formatRelativeTime(timestampMs: number, nowMs: number): string {
  const seconds = Math.round((nowMs - timestampMs) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
