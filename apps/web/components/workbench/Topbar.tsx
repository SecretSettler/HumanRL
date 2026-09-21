"use client";

import Link from "next/link";
import { useState } from "react";

import { useWorkbenchStore } from "@/lib/workbench/store";
import { fetchGraph, fetchRevisions } from "@/lib/workbench/trace-api";
import { useReplay } from "@/lib/workbench/use-replay";
import type { ConnectionStatus } from "@/lib/workbench/types";

const connectionLabels: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  live: "Connected",
  reconnecting: "Reconnecting…",
  backfilling: "正在补发",
};

const connectionTone: Record<ConnectionStatus, string> = {
  connecting: "text-muted border-line",
  live: "text-green border-green/40",
  reconnecting: "text-amber border-amber/40",
  backfilling: "text-accent-2 border-accent-2/40",
};

export function Topbar({ traceId }: { traceId: string }) {
  const snapshot = useWorkbenchStore((state) => state.snapshot);
  const graph = useWorkbenchStore((state) => state.graph);
  const connection = useWorkbenchStore((state) => state.connection);
  const inspectorOpen = useWorkbenchStore((state) => state.inspectorOpen);
  const setInspectorOpen = useWorkbenchStore((state) => state.setInspectorOpen);
  const mode = useWorkbenchStore((state) => state.mode);
  const store = useWorkbenchStore;
  const [switching, setSwitching] = useState(false);
  const replay = useReplay();

  const revision = graph?.revision ?? snapshot?.revision ?? null;

  const switchMode = async (target: "live" | "final") => {
    if (switching || mode === target) return;
    setSwitching(true);
    try {
      if (target === "live") {
        const latest = await fetchGraph(traceId);
        store.getState().setMode("live");
        store.getState().setGraph(latest);
        store.getState().setNotice(null);
        return;
      }
      const revisions = await fetchRevisions(traceId);
      const finalRevision =
        revisions.find((entry) => entry.branchKind === "final" && !entry.stale) ??
        revisions.find((entry) => entry.branchKind === "final");
      if (!finalRevision) {
        store.getState().setNotice("尚无 final revision；继续显示 live 解释。");
        return;
      }
      const finalGraph = await fetchGraph(traceId, finalRevision.id);
      if (!finalGraph) {
        store.getState().setNotice("final revision 加载失败。");
        return;
      }
      store.getState().setMode("final");
      store.getState().setGraph(finalGraph);
      store.getState().setNotice(null);
    } catch (reason) {
      store.getState().setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <header className="flex items-center gap-4 border-b border-line bg-bg/88 px-4 backdrop-blur-md">
      <Link
        href="/"
        className="flex items-center gap-2.5 no-underline"
        aria-label="IntentTrace home"
      >
        <span
          aria-hidden
          className="grid size-[30px] place-items-center rounded-[9px] bg-[conic-gradient(from_180deg,#8b7cf6,#59b6ff,#49d6d0,#8b7cf6)] p-[2px]"
        >
          <span className="grid size-full place-items-center rounded-[7px] bg-bg text-meta font-bold text-ink">
            ◎
          </span>
        </span>
        <span className="leading-tight">
          <span className="block text-title font-bold text-ink">IntentTrace</span>
          <span className="block text-micro text-muted-2">Evidence-backed agent traces</span>
        </span>
      </Link>
      <Link href="/import" className="ui-button ui-button--ghost">
        Import
      </Link>
      <div className="min-w-0 flex-1 border-l border-line-soft pl-4 leading-tight">
        <p className="m-0 truncate text-title font-semibold" title={snapshot?.trace.title}>
          {snapshot?.trace.title ?? "Loading trace…"}
        </p>
        <p className="m-0 truncate text-micro text-muted-2">
          {traceId} · {snapshot?.trace.status ?? "loading"}
        </p>
      </div>
      <div
        className="flex items-center gap-0.5 rounded-[10px] border border-line bg-panel-2 p-[3px]"
        role="group"
        aria-label="Revision branch"
        data-testid="branch-toggle"
      >
        {(["live", "final"] as const).map((branch) => (
          <button
            key={branch}
            type="button"
            disabled={switching}
            aria-pressed={mode === branch}
            onClick={() => void switchMode(branch)}
            className={`rounded-[7px] border-0 px-3 py-1 text-body capitalize ${
              mode === branch ? "bg-panel-3 font-semibold text-ink" : "bg-transparent text-muted"
            }`}
          >
            {branch}
          </button>
        ))}
        {revision && revision.branchKind !== "live" && revision.branchKind !== "final" ? (
          <span className="px-2 text-micro text-muted-2">{revision.branchKind}</span>
        ) : null}
        {revision?.stale ? (
          <span className="rounded-md border border-amber/40 px-1.5 py-0.5 text-micro text-amber">
            stale
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5" role="group" aria-label="Replay controls">
        <button
          type="button"
          data-testid="replay-toggle"
          disabled={!replay.canReplay}
          onClick={replay.toggle}
          className={`rounded-[10px] px-3 py-1.5 text-body ${
            replay.playing ? "border-line text-muted" : "border-accent/45 bg-accent/13 text-ink"
          }`}
        >
          {replay.playing ? "Ⅱ Pause" : "▶ Replay"}
        </button>
        <button
          type="button"
          data-testid="replay-restart"
          disabled={!replay.canReplay}
          onClick={replay.restart}
          title="Rewind the ingest watermark to the beginning"
          className="rounded-[10px] px-2.5 py-1.5 text-body text-muted"
        >
          ↺
        </button>
      </div>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-body ${connectionTone[connection]}`}
        data-testid="connection-pill"
      >
        <span
          aria-hidden
          className={`size-1.5 rounded-full ${
            connection === "live"
              ? "bg-green shadow-[0_0_6px_rgba(83,212,138,0.8)]"
              : connection === "reconnecting"
                ? "bg-amber"
                : "bg-muted"
          }`}
        />
        {connectionLabels[connection]}
      </span>
      <button
        type="button"
        className="inspector-toggle hidden rounded-lg px-3 py-1.5 text-body"
        onClick={() => setInspectorOpen(!inspectorOpen)}
        aria-expanded={inspectorOpen}
      >
        Evidence
      </button>
    </header>
  );
}
