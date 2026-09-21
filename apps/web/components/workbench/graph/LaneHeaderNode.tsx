"use client";

import type { NodeProps } from "@xyflow/react";

export interface LaneHeaderNodeData extends Record<string, unknown> {
  label: string;
  color: string;
  height: number;
  width: number;
}

/**
 * Non-interactive lane marker rendered inside the flow coordinate system so
 * the header and guide line pan and zoom with the cards they label.
 */
export function LaneHeaderNode({ data }: NodeProps & { data: LaneHeaderNodeData }) {
  return (
    <div
      className="pointer-events-none select-none"
      style={{ width: data.width, height: data.height }}
      aria-hidden
    >
      <div className="flex items-center justify-center gap-1.5">
        <span className="size-[7px] rounded-full" style={{ background: data.color }} />
        <span className="truncate text-micro font-bold uppercase tracking-[0.13em] text-[#536076]">
          {data.label}
        </span>
      </div>
      <div
        className="mx-auto mt-2 w-px"
        style={{
          height: Math.max(0, data.height - 24),
          background: "linear-gradient(180deg, var(--color-line-soft), transparent)",
          opacity: 0.65,
        }}
      />
    </div>
  );
}
