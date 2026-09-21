"use client";

import { useEffect, useMemo, useState } from "react";

import { fetchTraceList } from "@/lib/workbench/trace-api";
import type { TraceSummary } from "@/lib/workbench/types";

import { BudgetCard } from "./BudgetCard";
import { TraceListItem } from "./TraceListItem";

export function TraceSidebar({ activeTraceId }: { activeTraceId: string }) {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchTraceList()
      .then((result) => {
        if (!cancelled) setTraces(result.traces);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setListError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
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
    <div className="flex h-full flex-col">
      <div className="border-b border-line-soft p-3">
        <p className="m-0 mb-2 text-micro font-bold uppercase tracking-[0.13em] text-muted-2">
          Traces
        </p>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search intent, trace id…"
          aria-label="Search traces"
          className="w-full rounded-[9px] border border-line bg-[#0d1118] px-2.5 py-1.5 text-body placeholder:text-muted-2"
        />
      </div>
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" aria-label="Trace list">
        {listError ? (
          <p className="m-0 px-2 py-1 text-meta text-amber">Trace list unavailable: {listError}</p>
        ) : filtered.length === 0 ? (
          <p className="m-0 px-2 py-1 text-meta text-muted-2">
            {traces.length === 0 ? "No local traces yet." : "No traces match the search."}
          </p>
        ) : (
          filtered.map((trace) => (
            <TraceListItem key={trace.id} trace={trace} active={trace.id === activeTraceId} />
          ))
        )}
      </nav>
      <div className="border-t border-line-soft p-3">
        <BudgetCard />
      </div>
    </div>
  );
}
