import { formatCostUsd, formatDurationBetween } from "./format";
import type {
  Confidence,
  Provenance,
  ProviderCallAudit,
  SemanticGraphSnapshot,
  SemanticNodeVersion,
  TraceSnapshot,
} from "./types";

interface ClaimLike {
  kind: "intent" | "action" | "outcome";
  text: string;
  provenance: Provenance;
  confidence: Confidence;
  evidenceEventIds: string[];
}

const confidenceRank: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

/** Conservative node confidence: the weakest claim wins. */
export function nodeConfidence(claims: readonly ClaimLike[]): Confidence {
  let lowest: Confidence = "high";
  for (const claim of claims) {
    if (confidenceRank[claim.confidence] < confidenceRank[lowest]) lowest = claim.confidence;
  }
  return lowest;
}

export function nodeProvenance(claims: readonly ClaimLike[]): Provenance {
  const seen = new Set(claims.map((claim) => claim.provenance));
  if (seen.size === 1) return claims[0]?.provenance ?? "inferred";
  return "mixed";
}

/** Card summary line: prefer the intent claim, fall back to the first claim. */
export function nodeSummaryText(claims: readonly ClaimLike[]): string {
  return (claims.find((claim) => claim.kind === "intent") ?? claims[0])?.text ?? "";
}

export function distinctEvidenceCount(claims: readonly ClaimLike[]): number {
  return new Set(claims.flatMap((claim) => claim.evidenceEventIds)).size;
}

/**
 * Failures-only view: issue nodes and blocked nodes stay visible together
 * with their ancestor chain via primaryParentId.
 */
export interface WorkbenchStats {
  duration: string;
  agents: number;
  rawEvents: string;
  nodes: number | null;
  failures: number;
  cost: string | null;
  /** Percent of raw events cited as claim evidence, 0-100; null when unknown. */
  evidenceCoverage: number | null;
}

export function deriveStats(
  snapshot: TraceSnapshot | null,
  graph: SemanticGraphSnapshot | null,
  providerCalls: readonly ProviderCallAudit[] | null,
): WorkbenchStats {
  const agents = snapshot?.agents ?? [];
  const laneStart = agents.map((lane) => lane.startedAt).sort()[0] ?? null;
  const laneEnd =
    agents
      .map((lane) => lane.endedAt)
      .sort()
      .at(-1) ?? null;
  const duration =
    laneStart && laneEnd
      ? formatDurationBetween(laneStart, laneEnd)
      : formatDurationBetween(snapshot?.trace.createdAt ?? null, snapshot?.trace.updatedAt ?? null);
  const rawEventCount = Number(snapshot?.trace.eventCount ?? 0);
  const failureNodes =
    graph?.nodes.filter((node) => node.kind === "issue" || node.status === "blocked").length ?? 0;
  const laneErrors = agents.reduce((sum, lane) => sum + lane.errorCount, 0);
  let evidenceCoverage: number | null = null;
  if (graph && rawEventCount > 0) {
    const cited = new Set(
      graph.nodes.flatMap((node) => node.claims.flatMap((claim) => claim.evidenceEventIds)),
    );
    evidenceCoverage = Math.min(100, Math.round((cited.size / rawEventCount) * 100));
  }
  return {
    duration,
    agents: agents.length,
    rawEvents: snapshot?.trace.eventCount ?? "0",
    nodes: graph ? graph.nodes.length : null,
    failures: laneErrors + failureNodes,
    cost: providerCalls ? formatCostUsd(providerCalls.map((call) => call.costUsd)) : null,
    evidenceCoverage,
  };
}

export interface NowState {
  text: string;
  sub: string;
  live: boolean;
}

const terminalStatuses = new Set(["completed", "abandoned", "superseded"]);

export function deriveNowState(
  snapshot: TraceSnapshot | null,
  graph: SemanticGraphSnapshot | null,
  rawOnlyReason: string | null = null,
): NowState {
  if (rawOnlyReason) {
    return {
      text: `raw-only 模式：summarizer 失败（${rawOnlyReason}）。`,
      sub: "Raw trace remains browsable; semantic updates are paused.",
      live: false,
    };
  }
  if (!graph) {
    return {
      text: "原始事件已就绪，语义图尚未生成。",
      sub: "Raw trace remains available even when the summarizer is pending.",
      live: false,
    };
  }
  const open = [...graph.nodes].reverse().find((node) => !terminalStatuses.has(node.status));
  const result = graph.nodes.find((node) => node.kind === "result");
  const picked = open ?? result ?? graph.nodes.at(-1) ?? null;
  return {
    text: picked ? picked.title : "语义图为空。",
    sub: `${graph.revision.branchKind} r${graph.revision.eventWatermark}${
      graph.revision.stale ? " · stale" : ""
    } · ${graph.nodes.length} nodes`,
    live: snapshot?.trace.status === "active",
  };
}

export function failureVisibleNodeIds(
  nodes: readonly Pick<
    SemanticNodeVersion,
    "logicalNodeId" | "kind" | "status" | "primaryParentId"
  >[],
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.logicalNodeId, node]));
  const visible = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== "issue" && node.status !== "blocked") continue;
    let current: (typeof nodes)[number] | undefined = node;
    while (current && !visible.has(current.logicalNodeId)) {
      visible.add(current.logicalNodeId);
      current = current.primaryParentId ? byId.get(current.primaryParentId) : undefined;
    }
  }
  return visible;
}
