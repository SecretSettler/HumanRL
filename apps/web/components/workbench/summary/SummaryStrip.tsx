"use client";

import { deriveNowState, deriveStats } from "@/lib/workbench/derive";
import { useWorkbenchStore } from "@/lib/workbench/store";

function StatTile({ label, value, delta }: { label: string; value: string; delta: string }) {
  return (
    <div className="rounded-[11px] border border-line bg-gradient-to-b from-[rgba(27,34,48,0.78)] to-[rgba(16,20,27,0.78)] px-2.5 py-2">
      <p className="m-0 truncate text-micro text-muted-2">{label}</p>
      <p className="m-0 mt-0.5 truncate text-metric font-bold text-ink">{value}</p>
      <p className="m-0 mt-0.5 truncate text-micro text-green">{delta}</p>
    </div>
  );
}

export function SummaryStrip() {
  const snapshot = useWorkbenchStore((state) => state.snapshot);
  const graph = useWorkbenchStore((state) => state.graph);
  const providerCalls = useWorkbenchStore((state) => state.providerCalls);
  const rawOnlyReason = useWorkbenchStore((state) => state.rawOnlyReason);

  const stats = deriveStats(snapshot, graph, providerCalls);
  const now = deriveNowState(snapshot, graph, rawOnlyReason);

  return (
    <section
      className="m-2 mb-0 grid grid-cols-[minmax(200px,1fr)_repeat(6,minmax(72px,96px))] items-stretch gap-2 max-[1439px]:grid-cols-[minmax(200px,1fr)_repeat(4,minmax(72px,96px))] max-[1023px]:grid-cols-1"
      aria-label="Trace summary"
      data-testid="summary-strip"
    >
      <div className="relative overflow-hidden rounded-[11px] border border-line bg-[rgba(12,16,22,0.7)] py-2 pl-4 pr-3 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent">
        <p className="m-0 flex items-center gap-1.5 text-micro font-bold uppercase tracking-[0.12em] text-muted-2">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${now.live ? "bg-green shadow-[0_0_6px_rgba(83,212,138,0.8)]" : "bg-muted-2"}`}
          />
          Current state
        </p>
        <p className="m-0 mt-1 truncate text-body font-semibold text-ink">{now.text}</p>
        <p className="m-0 mt-0.5 truncate text-micro text-muted-2">{now.sub}</p>
      </div>
      <StatTile label="Duration" value={stats.duration} delta={now.live ? "live" : "final"} />
      <StatTile
        label="Agents"
        value={String(stats.agents)}
        delta={stats.agents > 1 ? "parallel" : "single"}
      />
      <StatTile
        label="Events"
        value={stats.rawEvents}
        delta={stats.nodes !== null ? `→ ${stats.nodes} nodes` : "no graph"}
      />
      <StatTile
        label="Failures"
        value={String(stats.failures)}
        delta={stats.failures === 0 ? "clean" : "see filter"}
      />
      <StatTile
        label="Cost"
        value={stats.cost ?? "—"}
        delta={stats.cost ? "providers" : "no spend"}
      />
      <StatTile
        label="Evidence"
        value={stats.evidenceCoverage !== null ? `${stats.evidenceCoverage}%` : "—"}
        delta="cited"
      />
    </section>
  );
}
