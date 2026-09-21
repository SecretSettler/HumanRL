"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { useWorkbenchStore } from "@/lib/workbench/store";
import type { RawTraceEvent } from "@/lib/workbench/types";

const ROW_HEIGHT = 30;
const OVERSCAN = 12;
const VIEWPORT = 420;

/**
 * Windowed raw-event table: only rows near the scroll viewport render, so the
 * normative "load the full event set" rule stays affordable at 10k+ events.
 */
export function RawEventTable({ events }: { events: readonly RawTraceEvent[] }) {
  const selectedEventId = useWorkbenchStore((state) => state.selectedEventId);
  const store = useWorkbenchStore;
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const range = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(VIEWPORT / ROW_HEIGHT) + OVERSCAN * 2;
    return { first, last: Math.min(events.length, first + visibleCount) };
  }, [events.length, scrollTop]);

  useEffect(() => {
    if (!selectedEventId) return;
    const index = events.findIndex((event) => event.id === selectedEventId);
    if (index < 0 || !containerRef.current) return;
    const top = index * ROW_HEIGHT;
    const container = containerRef.current;
    if (top < container.scrollTop || top > container.scrollTop + VIEWPORT - ROW_HEIGHT) {
      container.scrollTop = Math.max(0, top - VIEWPORT / 2);
    }
  }, [events, selectedEventId]);

  return (
    <div
      ref={containerRef}
      className="overflow-auto"
      style={{ maxHeight: VIEWPORT }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: events.length * ROW_HEIGHT, position: "relative" }}>
        {events.slice(range.first, range.last).map((event, offset) => (
          <button
            type="button"
            key={event.id}
            data-testid={`raw-row-${event.id}`}
            style={{
              position: "absolute",
              top: (range.first + offset) * ROW_HEIGHT,
              height: ROW_HEIGHT,
            }}
            className={selectedEventId === event.id ? "raw-row raw-row--selected" : "raw-row"}
            onClick={() => store.getState().selectEvent(event.id)}
          >
            <code>#{event.ingestSeq}</code>
            <span>{event.kind}</span>
            <strong className="truncate">{event.name}</strong>
            <small>{event.agentId ?? "system"}</small>
            <time>{new Date(event.occurredAt).toLocaleTimeString()}</time>
          </button>
        ))}
      </div>
    </div>
  );
}
