"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";

import type { TraceSourceKind } from "@intenttrace/schema";
import { Banner, Button, Chip, StatusBadge } from "@intenttrace/ui";

import { ImportRequestError, inspectCandidates, uploadSessionBundle } from "@/lib/import/api";
import {
  ALL_SOURCES,
  CANDIDATE_WINDOW,
  HEAD_BYTES,
  UPLOAD_CONCURRENCY,
  candidateRowsFromResponse,
  computeEmptyState,
  dedupeKey,
  fileRelativePath,
  formatBytes,
  formatRelativeTime,
  groupSelectedBundles,
  rankCandidates,
  summarize,
  visibleRows,
  type ImportRow,
} from "@/lib/import/view-model";

/**
 * Inspection failures the server can still resolve by re-detecting on the full
 * upload. An upload failure is always retryable — the operator already chose it.
 */
const retryableFailures = ["unknown_source_format", "preflight_failed"];

function selectable(row: ImportRow): boolean {
  if (row.failureStage !== "inspect") return true;
  return row.failureCode === null || retryableFailures.includes(row.failureCode);
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // 0x8000 keeps the spread below the argument-count limit for a 64 KiB head.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function ImportWorkspace() {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [phase, setPhase] = useState<"idle" | "inspecting" | "ready" | "importing">("idle");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>(ALL_SOURCES);
  const [hideImported, setHideImported] = useState(false);
  const [showPreviews, setShowPreviews] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [intake, setIntake] = useState({ skippedByLimit: 0, ignored: 0 });
  const nextRef = useRef(0);
  const partRowsRef = useRef<Map<string, ImportRow>>(new Map());
  const now = Date.now();

  const inspect = useCallback(async (target: readonly ImportRow[], includePreviews: boolean) => {
    if (target.length === 0) {
      setPhase("ready");
      return;
    }
    setPhase("inspecting");
    setInspectError(null);
    try {
      const parts = await Promise.all(
        target.map(async (row) => ({
          clientRef: row.clientRef,
          path: row.path,
          byteLength: row.size,
          modifiedAt: new Date(row.lastModified).toISOString(),
          headBase64: toBase64(await row.file.slice(0, HEAD_BYTES).arrayBuffer()),
          complete: row.size <= HEAD_BYTES,
        })),
      );
      const result = await inspectCandidates({
        protocolVersion: 2,
        includePreviews,
        parts,
      });
      for (const row of target) partRowsRef.current.set(row.clientRef, row);
      setRows((previous) => {
        const targetRefs = new Set(target.map((row) => row.clientRef));
        const retained = previous.filter((row) => !targetRefs.has(row.clientRef));
        return [...retained, ...candidateRowsFromResponse(target, result.candidates)];
      });
    } catch (error) {
      setInspectError(error instanceof Error ? error.message : String(error));
      setRows((previous) =>
        previous.map((row) => (row.status === "inspecting" ? { ...row, status: "failed" } : row)),
      );
    } finally {
      setPhase("ready");
    }
  }, []);

  // clientRef assignment and the inspect kick-off stay in the event handler: a
  // React state updater may be invoked more than once for a single update.
  const accept = useCallback(
    (files: readonly File[], mode: "folder" | "files") => {
      const ranked = rankCandidates(files, mode);
      setIntake(ranked);
      const known = new Set(rows.map((row) => row.key));
      const added: ImportRow[] = [];
      for (const file of ranked.window) {
        const key = dedupeKey(file);
        // First-wins: re-dropping the same folder must not duplicate rows.
        if (known.has(key)) continue;
        known.add(key);
        nextRef.current += 1;
        const path = fileRelativePath(file, mode);
        added.push({
          clientRef: `c${nextRef.current}`,
          key,
          file,
          path,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          status: "inspecting",
          selected: true,
          source: null,
          candidateId: null,
          partRefs: [`c${nextRef.current}`],
          title: null,
          projectHint: null,
          firstPromptPreview: null,
          lastPromptPreview: null,
          partialHead: file.size > HEAD_BYTES,
          imported: false,
          traceId: null,
          inserted: 0,
          duplicates: 0,
          failureCode: null,
          failureMessage: null,
          failureStage: null,
        });
        partRowsRef.current.set(`c${nextRef.current}`, added.at(-1)!);
      }
      if (added.length === 0) return;
      setRows((previous) => [...previous, ...added]);
      void inspect(added, showPreviews);
    },
    [inspect, rows, showPreviews],
  );

  const runImport = useCallback(async (target: readonly ImportRow[]) => {
    if (target.length === 0) return;
    setPhase("importing");
    const queued = new Set(target.map((row) => row.clientRef));
    setRows((previous) =>
      previous.map((row) =>
        queued.has(row.clientRef)
          ? {
              ...row,
              status: "queued",
              failureCode: null,
              failureMessage: null,
              failureStage: null,
            }
          : row,
      ),
    );
    const grouped = groupSelectedBundles(target, [...partRowsRef.current.values()]);
    const groups = grouped.groups;
    for (const failure of grouped.failures) {
      const refs = new Set(failure.rowRefs);
      setRows((previous) =>
        previous.map((entry) =>
          refs.has(entry.clientRef)
            ? {
                ...entry,
                status: "failed",
                failureCode: "missing_companion",
                failureMessage: failure.message,
                failureStage: "upload",
              }
            : entry,
        ),
      );
    }
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < groups.length) {
        const group = groups[cursor++]!;
        const refs = new Set(group.rowRefs);
        setRows((previous) =>
          previous.map((entry) =>
            refs.has(entry.clientRef) ? { ...entry, status: "uploading" } : entry,
          ),
        );
        try {
          const outcome = await uploadSessionBundle(group);
          const byId = new Map(outcome.results.map((result) => [result.candidateId, result]));
          setRows((previous) =>
            previous.map((entry) => {
              if (!refs.has(entry.clientRef) || !entry.candidateId) return entry;
              const result = byId.get(entry.candidateId);
              if (!result) return entry;
              return {
                ...entry,
                status: "imported",
                imported: true,
                traceId: result.traceId,
                inserted: result.inserted,
                duplicates: result.duplicates,
                failureCode: null,
                failureMessage: null,
                failureStage: null,
              };
            }),
          );
        } catch (error) {
          const code = error instanceof ImportRequestError ? error.code : "upload_failed";
          const message = error instanceof Error ? error.message : String(error);
          setRows((previous) =>
            previous.map((entry) =>
              refs.has(entry.clientRef)
                ? {
                    ...entry,
                    status: "failed",
                    failureCode: code,
                    failureMessage: message,
                    failureStage: "upload",
                  }
                : entry,
            ),
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, groups.length) }, worker));
    setPhase("ready");
  }, []);

  const detectedSources = useMemo(() => {
    const kinds: TraceSourceKind[] = [];
    for (const row of rows) {
      if (row.source && !kinds.includes(row.source)) kinds.push(row.source);
    }
    return kinds;
  }, [rows]);

  const filter = { query, source: sourceFilter, hideImported };
  const visible = visibleRows(rows, filter);
  const summary = summarize(rows);
  const alreadyImportedCount = rows.filter((row) => row.imported).length;
  const emptyState = computeEmptyState({
    isInspecting: phase === "inspecting",
    allInspectFailed: inspectError !== null,
    settled: phase === "ready" || phase === "importing",
    visibleCount: visible.length,
    totalCount: rows.length,
    alreadyImportedCount,
    isFiltered: query.trim() !== "" || sourceFilter !== ALL_SOURCES || hideImported,
  });
  const selectedRows = rows.filter((row) => row.selected && selectable(row));
  const failedRows = rows.filter((row) => row.status === "failed" && selectable(row));
  const busy = phase === "inspecting" || phase === "importing";

  const setSelected = (clientRef: string, selected: boolean) =>
    setRows((previous) =>
      previous.map((row) => (row.clientRef === clientRef ? { ...row, selected } : row)),
    );

  const setAllSelected = (selected: boolean) =>
    setRows((previous) =>
      previous.map((row) =>
        visible.some((entry) => entry.clientRef === row.clientRef) && selectable(row)
          ? { ...row, selected }
          : row,
      ),
    );

  const togglePreviews = (next: boolean) => {
    setShowPreviews(next);
    // Previews are the consent boundary; never fetch them before the toggle.
    void inspect(rows, next);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    if (files.length > 0) accept(files, "files");
  };

  return (
    <section className="flex flex-col gap-4" aria-label="Session import">
      <div
        data-testid="import-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        className="flex flex-col items-start gap-3 rounded-panel border border-dashed border-line bg-panel/60 px-5 py-6"
      >
        <p className="m-0 text-title font-semibold text-ink">
          把 Codex / Claude / JSONL / OTLP session 拖到这里
        </p>
        <p className="m-0 text-meta text-muted">
          文件只在你选择之后上传到本机 API；服务端不会扫描任何目录。单次最多 {CANDIDATE_WINDOW}{" "}
          个会话，先读取前 {formatBytes(HEAD_BYTES)} 用于识别。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="ui-button ui-button--secondary cursor-pointer">
            选择文件
            <input
              data-testid="import-file-input"
              type="file"
              multiple
              accept=".jsonl,.ndjson,.json"
              className="sr-only"
              onChange={(event) => {
                accept([...(event.target.files ?? [])], "files");
                event.target.value = "";
              }}
            />
          </label>
          <label className="ui-button ui-button--secondary cursor-pointer">
            选择目录
            <input
              data-testid="import-folder-input"
              type="file"
              className="sr-only"
              {...{ webkitdirectory: "", directory: "" }}
              onChange={(event) => {
                accept([...(event.target.files ?? [])], "folder");
                event.target.value = "";
              }}
            />
          </label>
        </div>
        {intake.skippedByLimit > 0 || intake.ignored > 0 ? (
          <p className="m-0 text-micro text-muted-2">
            {intake.skippedByLimit > 0 ? `超出窗口跳过 ${intake.skippedByLimit} 个· ` : ""}
            {intake.ignored > 0 ? `忽略 ${intake.ignored} 个非 session 文件` : ""}
          </p>
        ) : null}
      </div>

      {inspectError ? (
        <Banner tone="danger" role="alert">
          无法检查所选会话：{inspectError}
        </Banner>
      ) : null}

      {rows.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search file name, title…"
              aria-label="Search sessions"
              className="w-full max-w-[280px] rounded-[9px] border border-line bg-[#0d1118] px-3 py-2 text-body placeholder:text-muted-2"
            />
            <Chip
              selected={sourceFilter === ALL_SOURCES}
              data-testid="import-source-filter-all"
              onClick={() => setSourceFilter(ALL_SOURCES)}
            >
              All
            </Chip>
            {detectedSources.map((kind) => (
              <Chip
                key={kind}
                selected={sourceFilter === kind}
                data-testid={`import-source-filter-${kind}`}
                onClick={() => setSourceFilter(sourceFilter === kind ? ALL_SOURCES : kind)}
              >
                {kind}
              </Chip>
            ))}
            <Chip
              selected={hideImported}
              data-testid="import-hide-imported"
              onClick={() => setHideImported(!hideImported)}
            >
              Hide already imported
            </Chip>
            <Chip
              selected={showPreviews}
              data-testid="import-preview-toggle"
              onClick={() => togglePreviews(!showPreviews)}
            >
              Show prompt previews
            </Chip>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="import-refresh"
              disabled={busy}
              onClick={() => void inspect(rows, showPreviews)}
            >
              Refresh
            </Button>
            <Button onClick={() => setAllSelected(true)}>Select all</Button>
            <Button onClick={() => setAllSelected(false)}>Select none</Button>
            {failedRows.length > 0 ? (
              <Button
                data-testid="import-retry-failed"
                disabled={busy}
                onClick={() => void runImport(failedRows)}
              >
                Retry failed ({failedRows.length})
              </Button>
            ) : null}
            <Button
              variant="primary"
              data-testid="import-run"
              disabled={busy || selectedRows.length === 0}
              onClick={() => void runImport(selectedRows)}
            >
              Import {selectedRows.length} sessions
            </Button>
          </div>
        </div>
      ) : null}

      {summary.imported > 0 || summary.failed > 0 ? (
        <Banner tone={summary.failed > 0 ? "warning" : "success"}>
          <span data-testid="import-summary">
            {summary.imported} imported · {summary.duplicates} duplicates · {summary.failed} failed
          </span>
        </Banner>
      ) : null}

      <ul className="m-0 grid list-none gap-1.5 p-0" aria-label="Session candidates">
        {visible.map((row) => (
          <li
            key={row.key}
            data-testid={`import-row-${row.clientRef}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-panel border border-line bg-panel px-4 py-3"
          >
            <input
              type="checkbox"
              checked={row.selected && selectable(row)}
              disabled={!selectable(row)}
              aria-label={`Select ${row.name}`}
              onChange={(event) => setSelected(row.clientRef, event.target.checked)}
              className="mt-1"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ui-chip">{row.source ?? "unknown"}</span>
                <span className="truncate text-title font-semibold text-ink">
                  {row.title ?? row.name}
                </span>
                {row.imported ? <StatusBadge tone="ok">already imported</StatusBadge> : null}
                {row.partialHead ? <StatusBadge tone="neutral">head only</StatusBadge> : null}
              </div>
              <p className="m-0 mt-0.5 truncate text-micro text-muted-2">
                {row.name}
                {row.projectHint ? ` · ${row.projectHint}` : ""} ·{" "}
                {formatRelativeTime(row.lastModified, now)} · {formatBytes(row.size)}
              </p>
              {showPreviews && row.firstPromptPreview ? (
                <p className="m-0 mt-1.5 line-clamp-2 text-meta text-muted">
                  {row.firstPromptPreview}
                </p>
              ) : null}
              {showPreviews && row.lastPromptPreview ? (
                <p className="m-0 mt-1 line-clamp-2 text-meta text-muted-2">
                  {row.lastPromptPreview}
                </p>
              ) : null}
              {row.failureMessage ? (
                <p className="m-0 mt-1.5 text-meta text-red">
                  {row.failureCode}: {row.failureMessage}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-1">
              <span
                data-testid={`import-row-status-${row.clientRef}`}
                className="text-micro text-muted"
              >
                {row.status}
              </span>
              {row.status === "imported" ? (
                <span className="text-micro text-muted-2">
                  +{row.inserted} / dup {row.duplicates}
                </span>
              ) : null}
              {row.traceId ? (
                <Link
                  href={`/traces/${row.traceId}`}
                  className="text-micro no-underline hover:underline"
                >
                  View trace →
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {emptyState.show ? <p className="px-1 text-meta text-muted-2">{emptyState.title}</p> : null}
    </section>
  );
}
