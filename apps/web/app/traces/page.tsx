"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type { TraceSummary } from "@intenttrace/schema";
import { Banner, CopyButton } from "@intenttrace/ui";

import { AppHeader } from "@/components/AppHeader";
import { BoundaryBar } from "@/components/BoundaryBar";

const statusDot: Record<TraceSummary["status"], string> = {
  active: "bg-green shadow-[0_0_8px_rgba(83,212,138,0.7)]",
  completed: "bg-accent-2",
  stale: "bg-amber",
  failed: "bg-red",
};

const cliCommands = `intenttrace discover --source codex --path ~/.codex/sessions --limit 50
SESSION_ID="paste-24-character-catalog-id"
intenttrace import --source codex --path ~/.codex/sessions --session "$SESSION_ID"`;

function duration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export default function TraceListPage() {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void fetch("/api/v1/traces", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`API ${response.status}`);
        return (await response.json()) as { traces: TraceSummary[] };
      })
      .then((result) => setTraces(result.traces))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return traces;
    return traces.filter(
      (trace) =>
        trace.title.toLowerCase().includes(needle) || trace.id.toLowerCase().includes(needle),
    );
  }, [query, traces]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1080px] flex-col gap-4 px-6 py-8">
      <AppHeader />
      <BoundaryBar />

      <div className="flex items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search intent, trace id…"
          aria-label="Search traces"
          className="w-full max-w-[380px] rounded-[9px] border border-line bg-[#0d1118] px-3 py-2 text-body placeholder:text-muted-2"
        />
        <span className="text-micro text-muted-2">
          {filtered.length} / {traces.length} traces
        </span>
        <Link href="/import" className="ui-button ui-button--primary ml-auto">
          Import sessions
        </Link>
      </div>

      {error ? (
        <Banner tone="danger" role="alert">
          无法连接本地 API：{error}
        </Banner>
      ) : null}

      <section className="grid gap-1.5" aria-label="Local traces">
        {filtered.map((trace) => (
          <Link
            key={trace.id}
            href={`/traces/${trace.id}`}
            className="trace-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-panel border border-line bg-panel px-4 py-3 no-underline transition-colors hover:border-accent/40 hover:bg-panel-3"
          >
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-2 flex-none rounded-full ${statusDot[trace.status]}`}
                />
                <span className="truncate text-title font-semibold text-ink">{trace.title}</span>
              </span>
              <span className="mt-0.5 block truncate pl-4 text-micro text-muted-2">{trace.id}</span>
            </span>
            <span className="trace-row__events text-micro text-muted">
              {trace.eventCount} events
            </span>
            <span className="trace-row__duration text-micro text-muted">
              {duration(trace.createdAt, trace.updatedAt)}
            </span>
            <span className="text-micro text-muted">{trace.status}</span>
          </Link>
        ))}
        {!error && traces.length === 0 ? (
          <div className="grid gap-3 rounded-panel border border-line bg-panel p-6">
            <div>
              <h2 className="m-0 text-title font-semibold">尚无 trace</h2>
              <p className="mt-2 text-meta text-muted">
                在浏览器里选择本机上的 session 文件或目录即可导入；也可以用 collector
                在显式授权根内批量导入，或向 OTLP HTTP JSON receiver 发送 span。默认不输出
                prompt、路径或 native session ID。
              </p>
            </div>
            <Link
              href="/import"
              className="ui-button ui-button--primary w-fit"
              data-testid="empty-import-link"
            >
              Import from this browser
            </Link>
            <details className="rounded-lg border border-line bg-[#05070c] p-3">
              <summary className="cursor-pointer text-meta text-muted">
                Headless / bulk import (CLI)
              </summary>
              <pre className="mt-2 overflow-x-auto text-meta text-muted">{cliCommands}</pre>
              <CopyButton value={cliCommands} label="Copy commands" />
            </details>
          </div>
        ) : null}
        {!error && traces.length > 0 && filtered.length === 0 ? (
          <p className="px-1 text-meta text-muted-2">No traces match the search.</p>
        ) : null}
      </section>
    </div>
  );
}
