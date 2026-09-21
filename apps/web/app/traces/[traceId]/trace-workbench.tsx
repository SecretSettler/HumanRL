"use client";

import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo } from "react";

import { Banner } from "@intenttrace/ui";

import { Topbar } from "@/components/workbench/Topbar";
import { WorkbenchShell } from "@/components/workbench/WorkbenchShell";
import { GanttPanel } from "@/components/workbench/gantt/GanttPanel";
import { GraphPanel } from "@/components/workbench/graph/GraphPanel";
import { InspectorPanel } from "@/components/workbench/inspector/InspectorPanel";
import { RawEventTable } from "@/components/workbench/raw/RawEventTable";
import { TraceSidebar } from "@/components/workbench/sidebar/TraceSidebar";
import { SummaryStrip } from "@/components/workbench/summary/SummaryStrip";
import {
  fetchEventsAfter,
  fetchGraph,
  fetchProviderCalls,
  fetchSnapshot,
} from "@/lib/workbench/trace-api";
import { useWorkbenchStore } from "@/lib/workbench/store";
import { useTraceStream } from "@/lib/workbench/use-trace-stream";
import { useWorkbenchKeyboard } from "@/lib/workbench/use-workbench-keyboard";

const panelClass =
  "m-2 mt-0 flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-panel/95";

export function TraceWorkbench({ traceId }: { traceId: string }) {
  const snapshot = useWorkbenchStore((state) => state.snapshot);
  const playhead = useWorkbenchStore((state) => state.playhead);
  const error = useWorkbenchStore((state) => state.error);
  const notice = useWorkbenchStore((state) => state.notice);
  const inspectorOpen = useWorkbenchStore((state) => state.inspectorOpen);

  const store = useWorkbenchStore;

  useEffect(() => {
    store.getState().reset();
  }, [store, traceId]);

  const refresh = useCallback(async () => {
    const [nextSnapshot, nextGraph] = await Promise.all([
      fetchSnapshot(traceId),
      fetchGraph(traceId),
    ]);
    if (nextSnapshot.raw.nextCursor) {
      const rest = await fetchEventsAfter(traceId, nextSnapshot.raw.nextCursor);
      nextSnapshot.raw = { events: [...nextSnapshot.raw.events, ...rest], nextCursor: null };
    }
    store.getState().setSnapshot(nextSnapshot);
    if (store.getState().mode === "live") store.getState().setGraph(nextGraph);
  }, [store, traceId]);

  useTraceStream(traceId, refresh);
  useWorkbenchKeyboard();

  useEffect(() => {
    void refresh().catch((reason: unknown) =>
      store.getState().setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refresh, store]);

  useEffect(() => {
    let cancelled = false;
    fetchProviderCalls(traceId)
      .then((result) => {
        if (!cancelled) store.getState().setProviderCalls(result.calls);
      })
      .catch(() => {
        if (!cancelled) store.getState().setProviderCalls([]);
      });
    return () => {
      cancelled = true;
    };
  }, [store, traceId]);

  const raw = useMemo(
    () => (snapshot?.raw.events ?? []).filter((event) => Number(event.ingestSeq) <= playhead),
    [playhead, snapshot],
  );

  const mainColumn = (
    <>
      {error ? (
        <Banner tone="danger" role="alert" className="m-2 mb-0">
          {error}
        </Banner>
      ) : null}
      {notice ? (
        <Banner tone="warning" className="m-2 mb-0">
          {notice}
        </Banner>
      ) : null}
      <SummaryStrip />
      <section
        className="m-2 grid grid-cols-[260px_1fr_auto] items-center gap-4 rounded-xl border border-line bg-panel px-3 py-2 max-[1023px]:grid-cols-1"
        aria-label="Replay controls"
      >
        <label htmlFor="playhead" className="text-title">
          Known at ingest watermark <strong>{playhead}</strong>
        </label>
        <input
          id="playhead"
          data-testid="replay-slider"
          type="range"
          min="0"
          max={Number(snapshot?.trace.latestIngestSeq ?? 0)}
          value={playhead}
          onChange={(event) => store.getState().setPlayhead(Number(event.target.value))}
        />
        <button
          type="button"
          data-testid="playhead-latest"
          className="px-3 py-1.5 text-title"
          onClick={() => store.getState().setPlayhead(Number(snapshot?.trace.latestIngestSeq ?? 0))}
        >
          Jump to latest
        </button>
      </section>
      <section
        className={`${panelClass} graph-panel h-[52vh] min-h-[420px] flex-none`}
        aria-label="Intent graph"
      >
        <GraphPanel />
      </section>
      <section className={`${panelClass} max-h-[280px] flex-none`} aria-label="Agent Gantt">
        <GanttPanel />
      </section>
      <section className={`${panelClass} flex-none`} aria-label="Raw events">
        <div className="panel-heading">
          <h2>Raw Events</h2>
          <span data-testid="raw-count">{raw.length} immutable facts</span>
        </div>
        <RawEventTable events={raw} />
      </section>
    </>
  );

  return (
    <WorkbenchShell
      topbar={<Topbar traceId={traceId} />}
      sidebar={<TraceSidebar activeTraceId={traceId} />}
      main={mainColumn}
      inspector={<InspectorPanel traceId={traceId} />}
      inspectorOpen={inspectorOpen}
    />
  );
}
