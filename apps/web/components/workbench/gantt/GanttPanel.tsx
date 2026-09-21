"use client";

import { useMemo, useState } from "react";

import { agentColor, laneOrderFor } from "@/lib/workbench/agent-colors";
import { useWorkbenchStore } from "@/lib/workbench/store";
import {
  bucketByFraction,
  computeTimeDomain,
  laneBucketCount,
  timeFraction,
  timeTicks,
} from "@/lib/workbench/time-scale";
import type { RawTraceEvent } from "@/lib/workbench/types";

const TOOL_KINDS = new Set([
  "tool_call",
  "tool_result",
  "file_read",
  "file_write",
  "shell_command",
]);

export function GanttPanel() {
  const snapshot = useWorkbenchStore((state) => state.snapshot);
  const playhead = useWorkbenchStore((state) => state.playhead);
  const selectedEventId = useWorkbenchStore((state) => state.selectedEventId);
  const store = useWorkbenchStore;
  const [collapseTools, setCollapseTools] = useState(false);

  const visibleById = useMemo(() => {
    const map = new Map<string, RawTraceEvent>();
    for (const event of snapshot?.raw.events ?? []) {
      if (Number(event.ingestSeq) <= playhead) map.set(event.id, event);
    }
    return map;
  }, [playhead, snapshot]);

  const lanes = useMemo(() => {
    const agents = snapshot?.agents ?? [];
    const laneOrder = laneOrderFor(
      agents.map((lane) => lane.agentId),
      [],
    );
    return agents.map((lane) => {
      const events = lane.eventIds
        .map((id) => visibleById.get(id))
        .filter((event): event is RawTraceEvent => Boolean(event))
        .filter((event) => !collapseTools || !TOOL_KINDS.has(event.kind));
      return { lane, events, color: agentColor(laneOrder, lane.agentId) };
    });
  }, [collapseTools, snapshot, visibleById]);

  const domain = useMemo(() => {
    const stamps: number[] = [];
    for (const { events } of lanes)
      for (const event of events) stamps.push(Date.parse(event.occurredAt));
    return computeTimeDomain(stamps);
  }, [lanes]);

  const playheadFraction = useMemo(() => {
    if (!domain) return null;
    let latest = -Infinity;
    for (const event of visibleById.values()) {
      const at = Date.parse(event.occurredAt);
      if (at > latest) latest = at;
    }
    return Number.isFinite(latest) ? timeFraction(domain, latest) : null;
  }, [domain, visibleById]);

  const ticks = domain ? timeTicks(domain) : [];

  return (
    <>
      <div className="panel-heading">
        <h2>Agent Gantt</h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-pressed={!collapseTools}
            onClick={() => setCollapseTools(false)}
            className={`rounded-lg border px-2 py-1 text-micro ${
              !collapseTools
                ? "border-accent/35 bg-accent/12 text-ink"
                : "border-line bg-transparent text-muted"
            }`}
          >
            All spans
          </button>
          <button
            type="button"
            aria-pressed={collapseTools}
            onClick={() => setCollapseTools(true)}
            className={`rounded-lg border px-2 py-1 text-micro ${
              collapseTools
                ? "border-accent/35 bg-accent/12 text-ink"
                : "border-line bg-transparent text-muted"
            }`}
          >
            Collapse tools
          </button>
          <span className="ml-2 text-micro text-muted-2">source time</span>
        </div>
      </div>
      <div className="grid min-h-0 grid-cols-[130px_1fr_84px] overflow-y-auto">
        <div aria-hidden className="border-b border-line-soft" />
        <div className="relative h-[25px] border-b border-line-soft">
          {ticks.map((tick) => (
            <span
              key={tick.offsetMs}
              aria-hidden
              className="absolute top-0 flex h-full -translate-x-1/2 items-center text-micro text-muted-2"
              style={{ left: `${tick.fraction * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
          {playheadFraction !== null ? (
            <span
              aria-hidden
              className="absolute top-0 z-10 h-full w-px bg-accent-2 shadow-[0_0_10px_rgba(89,182,255,0.8)]"
              style={{ left: `${playheadFraction * 100}%` }}
            />
          ) : null}
        </div>
        <div aria-hidden className="border-b border-line-soft" />
        {lanes.map(({ lane, events, color }) => {
          const laneStamps = events.map((event) => Date.parse(event.occurredAt));
          const laneDomain = computeTimeDomain(laneStamps);
          return (
            <div key={lane.agentId} className="contents">
              <div className="flex items-center gap-2 border-b border-line-soft py-1.5 pl-4 pr-2">
                <span
                  aria-hidden
                  className="size-[7px] flex-none rounded-full"
                  style={{ background: color }}
                />
                <span className="truncate text-body font-semibold">{lane.displayName}</span>
              </div>
              <div className="relative border-b border-line-soft py-1.5">
                {ticks.map((tick) => (
                  <span
                    key={tick.offsetMs}
                    aria-hidden
                    className="absolute inset-y-0 w-px bg-white/[0.04]"
                    style={{ left: `${tick.fraction * 100}%` }}
                  />
                ))}
                {playheadFraction !== null ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 z-10 w-px bg-accent-2/70"
                    style={{ left: `${playheadFraction * 100}%` }}
                  />
                ) : null}
                {domain && laneDomain ? (
                  <span
                    aria-hidden
                    className="absolute top-1/2 h-[14px] -translate-y-1/2 rounded-[5px] border border-white/10 opacity-70"
                    style={{
                      left: `${timeFraction(domain, laneDomain.start) * 100}%`,
                      width: `${Math.max(0.5, (timeFraction(domain, laneDomain.end) - timeFraction(domain, laneDomain.start)) * 100)}%`,
                      background: color,
                      opacity: 0.35,
                    }}
                  />
                ) : null}
                {domain
                  ? (() => {
                      const buckets = bucketByFraction(
                        events,
                        (event) => timeFraction(domain, Date.parse(event.occurredAt)),
                        laneBucketCount(events.length),
                      );
                      const densest = buckets.reduce(
                        (max, bucket) => Math.max(max, bucket.items.length),
                        1,
                      );
                      return buckets.map((bucket) => {
                        const target =
                          bucket.items.find((event) => event.id === selectedEventId) ??
                          bucket.items.find((event) => event.status === "error") ??
                          bucket.items[0]!;
                        const selected = bucket.items.some((event) => event.id === selectedEventId);
                        const hasError = bucket.items.some((event) => event.status === "error");
                        const count = bucket.items.length;
                        const density = count / densest;
                        return (
                          <button
                            key={bucket.index}
                            type="button"
                            data-testid={`gantt-marker-${target.id}`}
                            aria-label={`${count} event${count > 1 ? "s" : ""} in ${
                              lane.displayName
                            }${hasError ? ", contains an error" : ""}: select #${target.ingestSeq} ${
                              target.name
                            }`}
                            title={`#${target.ingestSeq} ${target.name}${
                              count > 1 ? ` (+${count - 1} in this slice)` : ""
                            }`}
                            onClick={() => store.getState().selectEvent(target.id)}
                            className={`absolute top-1/2 -translate-y-1/2 rounded-[1px] border-0 p-0 ${
                              selected ? "z-20 rounded-[3px] ring-2 ring-amber" : ""
                            }`}
                            style={{
                              left: `${bucket.startFraction * 100}%`,
                              width: `max(2px, ${bucket.widthFraction * 100}%)`,
                              height: `${6 + Math.round(density * 8)}px`,
                              background: selected
                                ? "var(--color-amber)"
                                : hasError
                                  ? "var(--color-red)"
                                  : color,
                              opacity: hasError || selected ? 1 : 0.45 + density * 0.55,
                            }}
                          />
                        );
                      });
                    })()
                  : null}
              </div>
              <div className="flex items-center border-b border-line-soft pl-3 pr-3 text-micro text-muted">
                <span className={lane.errorCount ? "text-red" : ""}>
                  {lane.errorCount ? `${lane.errorCount} errors` : "ok"}
                </span>
              </div>
            </div>
          );
        })}
        {lanes.length === 0 ? (
          <p className="col-span-3 m-0 p-4 text-meta text-muted-2">
            No agent activity at this watermark.
          </p>
        ) : null}
      </div>
    </>
  );
}
