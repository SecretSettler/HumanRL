"use client";

import type { NodeProps } from "@xyflow/react";

export interface GhostNodeCardData extends Record<string, unknown> {
  jobId: string;
  eventWatermark: string;
}

/**
 * Deterministic SSE ghost: rendered from semantic_chunk.pending only —
 * never from unverified provider output.
 */
export function GhostNodeCard({ data }: NodeProps & { data: GhostNodeCardData }) {
  return (
    <div
      data-testid={`ghost-node-${data.jobId}`}
      aria-label={`Summarizing up to event ${data.eventWatermark}`}
      className="w-[246px] rounded-[13px] border border-dashed border-line bg-panel-2/80 p-[11px] opacity-80 saturate-50 motion-safe:animate-pulse"
    >
      <p className="m-0 text-micro font-bold uppercase tracking-[0.12em] text-muted-2">
        Summarizing
      </p>
      <p className="m-0 mt-1 text-meta font-semibold text-muted">
        Chunk up to #{data.eventWatermark}
      </p>
      <p className="m-0 mt-1.5 text-micro text-muted-2">
        Deterministic pending marker — semantic nodes appear after the reducer commits.
      </p>
    </div>
  );
}
