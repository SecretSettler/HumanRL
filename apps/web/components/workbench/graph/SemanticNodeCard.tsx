"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { distinctEvidenceCount, nodeConfidence, nodeSummaryText } from "@/lib/workbench/derive";
import { formatDurationBetween } from "@/lib/workbench/format";
import { nodeKindMeta, nodeStatusMeta } from "@/lib/workbench/graph-meta";
import type { SemanticNodeVersion } from "@/lib/workbench/types";

export interface SemanticNodeCardData extends Record<string, unknown> {
  node: SemanticNodeVersion;
  selected: boolean;
  dimmed: boolean;
}

const toneIconClass = {
  accent: "border-accent/35 bg-accent/12 text-accent",
  red: "border-red/35 bg-red/12 text-red",
  green: "border-green/35 bg-green/12 text-green",
  pink: "border-pink/35 bg-pink/12 text-pink",
} as const;

const toneCardClass = {
  accent: "border-[#303a4c]",
  red: "border-red/45",
  green: "border-green/40 shadow-[0_15px_44px_rgba(34,120,74,0.11)]",
  pink: "border-pink/40",
} as const;

const confidenceLabels = { high: "high", medium: "med", low: "low" } as const;

export function SemanticNodeCard({ data }: NodeProps & { data: SemanticNodeCardData }) {
  const { node, selected, dimmed } = data;
  const kind = nodeKindMeta[node.kind];
  const status = nodeStatusMeta[node.status];
  const confidence = nodeConfidence(node.claims);
  const evidenceCount = distinctEvidenceCount(node.claims);
  const duration = formatDurationBetween(node.startedAt, node.endedAt);

  return (
    <div
      data-testid={`node-card-${node.logicalNodeId}`}
      aria-label={`${kind.label} ${node.title}, ${status.label}`}
      className={`w-[246px] rounded-[13px] border bg-gradient-to-b from-[rgba(28,35,49,0.98)] to-[rgba(17,22,31,0.98)] p-[11px] pb-[10px] text-left shadow-[0_12px_30px_rgba(0,0,0,0.27)] transition-opacity ${toneCardClass[kind.tone]} ${
        selected ? "border-accent-2 ring-2 ring-accent-2/25" : ""
      } ${node.pinnedByHuman ? "ring-2 ring-accent/60" : ""} ${dimmed ? "opacity-[0.12]" : ""}`}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-[#3b4658]" />
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={`grid size-[25px] flex-none place-items-center rounded-lg border text-body ${toneIconClass[kind.tone]}`}
        >
          {kind.icon}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block text-micro font-bold uppercase tracking-[0.12em] text-muted-2">
            {kind.label}
          </span>
          <span className="block truncate text-title font-bold text-ink" title={node.title}>
            {node.title}
          </span>
        </span>
        <span className="flex-none rounded-md border border-line px-1.5 py-0.5 text-micro text-muted-2">
          {confidenceLabels[confidence]}
        </span>
      </div>
      <p className="m-0 mt-2 line-clamp-2 min-h-[32px] text-meta text-[#bbc4d2]">
        {nodeSummaryText(node.claims)}
      </p>
      <div className="mt-2 flex items-center gap-1.5 text-micro text-muted-2">
        {node.primaryAgentId ? <span className="truncate">{node.primaryAgentId}</span> : null}
        <span className="flex-none">· {evidenceCount} events</span>
        {duration !== "—" ? <span className="flex-none">· {duration}</span> : null}
        <span
          className={`ml-auto flex-none rounded-md border px-1.5 py-0.5 text-micro ${status.pillClass}`}
        >
          {status.label}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!size-1.5 !border-0 !bg-[#3b4658]"
      />
    </div>
  );
}
