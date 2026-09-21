"use client";

import { useEffect } from "react";

import { useWorkbenchStore } from "./store";
import { fetchEventsAfter, fetchGraph } from "./trace-api";

/**
 * Incremental SSE engine: buffers raw appends into batched delta fetches,
 * coalesces semantic events into a single throttled graph refetch, tracks
 * pending summarizer chunks as deterministic ghosts, and surfaces
 * resync/raw-only states. Never applies provider content directly.
 */
export function useTraceStream(traceId: string, fullRefresh: () => Promise<void>) {
  const store = useWorkbenchStore;

  useEffect(() => {
    const source = new EventSource(`/api/v1/traces/${traceId}/stream`);
    let rawFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let graphFlushTimer: ReturnType<typeof setTimeout> | undefined;
    let rawDirty = false;
    let sawLateOrGap = false;
    let pendingRevisionId: string | null = null;
    let fetching = false;
    let closed = false;

    const parse = (event: MessageEvent): Record<string, unknown> => {
      try {
        const envelope = JSON.parse(event.data as string) as { payload?: Record<string, unknown> };
        return envelope.payload ?? {};
      } catch {
        return {};
      }
    };

    const flushRaw = () => {
      rawFlushTimer = undefined;
      if (!rawDirty || fetching || closed) return;
      rawDirty = false;
      fetching = true;
      const state = store.getState();
      const lastSeq = state.snapshot?.raw.events.at(-1)?.ingestSeq ?? null;
      state.setConnection("backfilling");
      const load = sawLateOrGap
        ? fullRefresh()
        : fetchEventsAfter(traceId, lastSeq).then((events) =>
            store.getState().appendEvents(events),
          );
      sawLateOrGap = false;
      void load
        .catch(() => {
          rawDirty = true;
        })
        .finally(() => {
          fetching = false;
          if (!closed) store.getState().setConnection("live");
          if (rawDirty && !rawFlushTimer) rawFlushTimer = setTimeout(flushRaw, 250);
        });
    };

    const scheduleRaw = () => {
      rawDirty = true;
      rawFlushTimer ??= setTimeout(flushRaw, 250);
    };

    const flushGraph = () => {
      graphFlushTimer = undefined;
      if (closed) return;
      const revisionId = pendingRevisionId;
      pendingRevisionId = null;
      if (store.getState().mode === "final") return;
      void fetchGraph(traceId, revisionId ?? undefined).then((graph) => {
        if (closed || !graph) return;
        store.getState().setGraph(graph);
        store.getState().clearPendingChunks();
        store.getState().setRawOnlyReason(null);
      });
    };

    const scheduleGraph = (revisionId: string | null) => {
      if (revisionId) pendingRevisionId = revisionId;
      graphFlushTimer ??= setTimeout(flushGraph, 250);
    };

    source.onopen = () => store.getState().setConnection("live");
    source.onerror = () => {
      if (!closed) store.getState().setConnection("reconnecting");
    };

    source.addEventListener("raw_event.appended", (event) => {
      const payload = parse(event);
      if (payload.late === true) sawLateOrGap = true;
      scheduleRaw();
    });
    source.addEventListener("trace.completed", (event) => {
      parse(event);
      store.getState().patchTrace({ status: "completed" });
      scheduleRaw();
    });
    source.addEventListener("trace.metrics.updated", () => {
      scheduleRaw();
    });
    source.addEventListener("semantic_chunk.pending", (event) => {
      const payload = parse(event);
      if (typeof payload.jobId === "string") {
        store.getState().addPendingChunk(payload.jobId, String(payload.eventWatermark ?? ""));
      }
    });
    source.addEventListener("semantic_revision.created", (event) => {
      const payload = parse(event);
      scheduleGraph(typeof payload.revisionId === "string" ? payload.revisionId : null);
    });
    for (const type of [
      "semantic_node.committed",
      "semantic_node.updated",
      "semantic_edge.committed",
    ])
      source.addEventListener(type, () => scheduleGraph(null));
    source.addEventListener("summary.failed", (event) => {
      const payload = parse(event);
      store
        .getState()
        .setRawOnlyReason(typeof payload.errorCode === "string" ? payload.errorCode : "unknown");
      store.getState().clearPendingChunks();
    });
    source.addEventListener("resync.required", () => {
      store.getState().setNotice("事件游标已过期，正在重新加载快照。");
      void fullRefresh().finally(() => store.getState().setNotice(null));
    });

    return () => {
      closed = true;
      if (rawFlushTimer) clearTimeout(rawFlushTimer);
      if (graphFlushTimer) clearTimeout(graphFlushTimer);
      source.close();
    };
  }, [fullRefresh, store, traceId]);
}
