"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

import { edgeKindMeta } from "@/lib/workbench/graph-meta";
import type { SemanticEdgeKind } from "@/lib/workbench/types";

export interface WorkbenchEdgeData extends Record<string, unknown> {
  kind: SemanticEdgeKind;
}

export function WorkbenchEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps & { data?: WorkbenchEdgeData }) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const kind = data?.kind ?? "decomposes_to";
  const meta = edgeKindMeta[kind];
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: meta.color,
          strokeWidth: 2,
          strokeDasharray: meta.dash,
          strokeLinecap: "round",
          opacity: 0.85,
        }}
      />
      <EdgeLabelRenderer>
        <span
          className="pointer-events-none absolute rounded bg-bg/70 px-1 text-micro text-muted-2"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {kind}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}
