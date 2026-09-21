import Link from "next/link";

import { formatDurationBetween } from "@/lib/workbench/format";
import type { TraceSummary } from "@/lib/workbench/types";

const statusDot: Record<TraceSummary["status"], string> = {
  active: "bg-green shadow-[0_0_8px_rgba(83,212,138,0.7)]",
  completed: "bg-accent-2",
  stale: "bg-amber",
  failed: "bg-red",
};

export function TraceListItem({ trace, active }: { trace: TraceSummary; active: boolean }) {
  return (
    <Link
      href={`/traces/${trace.id}`}
      aria-current={active ? "page" : undefined}
      className={`relative block rounded-[11px] border px-3 py-2.5 pl-6 no-underline transition-colors ${
        active ? "border-accent/25 bg-accent/9" : "border-transparent hover:bg-white/[0.025]"
      }`}
    >
      <span
        aria-hidden
        className={`absolute left-2.5 top-[15px] size-2 rounded-full ${statusDot[trace.status]}`}
      />
      <span className="block truncate text-body font-semibold text-ink">{trace.title}</span>
      <span className="mt-0.5 block truncate text-micro text-muted-2">{trace.id}</span>
      <span className="mt-1 flex gap-2 text-micro text-muted">
        <span>{trace.eventCount} events</span>
        <span>{formatDurationBetween(trace.createdAt, trace.updatedAt)}</span>
        <span>{trace.status}</span>
      </span>
    </Link>
  );
}
