import { ReducerDerivedEdgeKindSchema, SemanticEdgeKindSchema } from "@intenttrace/schema";
import { describe, expect, it } from "vitest";

import {
  deriveNowState,
  deriveStats,
  distinctEvidenceCount,
  failureVisibleNodeIds,
  nodeConfidence,
  nodeProvenance,
  nodeSummaryText,
} from "./derive";
import type { SemanticGraphSnapshot, TraceSnapshot } from "./types";
import { edgeKindMeta, nodeKindMeta, nodeStatusMeta } from "./graph-meta";
import { formatCostUsd, formatDurationBetween, formatDurationMs } from "./format";

const claim = (
  overrides: Partial<Parameters<typeof nodeConfidence>[0][number]> = {},
): Parameters<typeof nodeConfidence>[0][number] => ({
  kind: "action",
  text: "did a thing",
  provenance: "stated",
  confidence: "high",
  evidenceEventIds: ["e1"],
  ...overrides,
});

describe("node derivations", () => {
  it("uses the weakest claim confidence", () => {
    expect(nodeConfidence([claim(), claim({ confidence: "low" })])).toBe("low");
    expect(nodeConfidence([claim({ confidence: "medium" }), claim()])).toBe("medium");
    expect(nodeConfidence([claim()])).toBe("high");
  });

  it("collapses provenance to mixed only when claims disagree", () => {
    expect(nodeProvenance([claim(), claim()])).toBe("stated");
    expect(nodeProvenance([claim(), claim({ provenance: "inferred" })])).toBe("mixed");
  });

  it("prefers the intent claim for the summary line", () => {
    expect(nodeSummaryText([claim(), claim({ kind: "intent", text: "wanted X" })])).toBe(
      "wanted X",
    );
    expect(nodeSummaryText([claim({ text: "fallback" })])).toBe("fallback");
    expect(nodeSummaryText([])).toBe("");
  });

  it("counts distinct evidence event ids across claims", () => {
    expect(
      distinctEvidenceCount([
        claim({ evidenceEventIds: ["a", "b"] }),
        claim({ evidenceEventIds: ["b", "c"] }),
      ]),
    ).toBe(3);
  });
});

describe("failureVisibleNodeIds", () => {
  const node = (
    id: string,
    kind: "work" | "issue",
    status: "active" | "blocked",
    parent: string | null,
  ) => ({ logicalNodeId: id, kind, status, primaryParentId: parent });

  it("keeps issues, blocked nodes, and their ancestor chain", () => {
    const nodes = [
      node("root", "work", "active", null),
      node("mid", "work", "active", "root"),
      node("bug", "issue", "blocked", "mid"),
      node("other", "work", "active", "root"),
    ];
    const visible = failureVisibleNodeIds(nodes);
    expect([...visible].sort()).toEqual(["bug", "mid", "root"]);
  });

  it("returns an empty set when nothing failed", () => {
    expect(failureVisibleNodeIds([node("a", "work", "active", null)]).size).toBe(0);
  });
});

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;

function makeSnapshot(): TraceSnapshot {
  return {
    trace: {
      id: uuid(1),
      projectId: uuid(2),
      title: "t",
      status: "active",
      eventCount: "10",
      latestIngestSeq: "10",
      latestRevisionId: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:02:04.000Z",
    },
    raw: { events: [], nextCursor: null },
    agents: [
      {
        agentId: "a",
        displayName: "A",
        eventIds: [],
        startedAt: "2026-08-03T00:00:00.000Z",
        endedAt: "2026-08-03T00:01:00.000Z",
        errorCount: 1,
      },
      {
        agentId: "b",
        displayName: "B",
        eventIds: [],
        startedAt: "2026-08-03T00:00:10.000Z",
        endedAt: "2026-08-03T00:02:00.000Z",
        errorCount: 0,
      },
    ],
    revision: null,
    topology: {
      declared: {
        spawn: "passthrough",
        join: "passthrough",
        peerMessages: "passthrough",
        input: "single-file",
        laneKey: "agentId",
        limits: [
          "Topology requires explicit canonical fields; passthrough never infers a missing relationship.",
        ],
      },
      observed: { lanes: 0, lanesWithParent: 0, spawnEdges: 0, peerEdges: 0 },
    },
  };
}

function makeGraph(): SemanticGraphSnapshot {
  const node = (n: number, kind: "work" | "issue", status: "completed" | "blocked") => ({
    id: uuid(n),
    logicalNodeId: uuid(n + 50),
    traceId: uuid(1),
    kind,
    status,
    title: `node ${n}`,
    claims: [
      {
        kind: "action" as const,
        text: "did",
        provenance: "stated" as const,
        confidence: "high" as const,
        evidenceEventIds: [uuid(n + 70), uuid(99)],
      },
    ],
    primaryParentId: null,
    primaryAgentId: null,
    participantAgentIds: [],
    artifactIds: [],
    pinnedByHuman: false,
    startedAt: null,
    endedAt: null,
    layout: null,
  });
  return {
    revision: {
      id: uuid(40),
      traceId: uuid(1),
      parentRevisionId: null,
      branchKind: "live",
      eventWatermark: "10",
      createdAt: "2026-08-03T00:01:00.000Z",
      sourceJobId: null,
      stale: false,
    },
    nodes: [node(1, "work", "completed"), node(2, "issue", "blocked")],
    edges: [],
  };
}

describe("deriveStats", () => {
  it("computes duration, counts, failures, cost, and coverage", () => {
    const stats = deriveStats(makeSnapshot(), makeGraph(), [
      {
        id: uuid(60),
        summaryJobId: uuid(61),
        provider: "deepseek",
        model: "m",
        status: "committed",
        inputTokens: "10",
        outputTokens: "5",
        costUsd: "0.010",
        createdAt: "2026-08-03T00:01:00.000Z",
      },
    ]);
    expect(stats.duration).toBe("2m 00s");
    expect(stats.agents).toBe(2);
    expect(stats.rawEvents).toBe("10");
    expect(stats.nodes).toBe(2);
    expect(stats.failures).toBe(2);
    expect(stats.cost).toBe("$0.010");
    expect(stats.evidenceCoverage).toBe(30);
  });

  it("handles missing snapshot and graph", () => {
    const stats = deriveStats(null, null, null);
    expect(stats.duration).toBe("—");
    expect(stats.nodes).toBeNull();
    expect(stats.cost).toBeNull();
    expect(stats.evidenceCoverage).toBeNull();
  });
});

describe("deriveNowState", () => {
  it("falls back to raw-only copy without a graph", () => {
    const now = deriveNowState(makeSnapshot(), null);
    expect(now.text).toContain("语义图尚未生成");
    expect(now.live).toBe(false);
  });

  it("picks the most recent non-terminal node", () => {
    const now = deriveNowState(makeSnapshot(), makeGraph());
    expect(now.text).toBe("node 2");
    expect(now.sub).toContain("live r10");
    expect(now.live).toBe(true);
  });

  it("reports raw-only mode when the summarizer failed", () => {
    const now = deriveNowState(makeSnapshot(), makeGraph(), "provider_timeout");
    expect(now.text).toContain("raw-only");
    expect(now.text).toContain("provider_timeout");
  });
});

describe("graph meta tables", () => {
  it("covers every semantic node kind, status, and edge kind", () => {
    expect(Object.keys(nodeKindMeta).sort()).toEqual(
      ["decision", "goal", "handoff", "issue", "request", "result", "work"].sort(),
    );
    expect(Object.keys(nodeStatusMeta).sort()).toEqual(
      ["abandoned", "active", "blocked", "completed", "proposed", "superseded"].sort(),
    );
    // The styling table must cover the full vocabulary for type completeness,
    // and must in particular cover every relation the reducer can derive.
    expect(Object.keys(edgeKindMeta).sort()).toEqual([...SemanticEdgeKindSchema.options].sort());
    for (const derived of ReducerDerivedEdgeKindSchema.options) {
      expect(edgeKindMeta[derived]).toBeDefined();
    }
  });
});

describe("format helpers", () => {
  it("formats durations across ranges", () => {
    expect(formatDurationMs(4_000)).toBe("4s");
    expect(formatDurationMs(124_000)).toBe("2m 04s");
    expect(formatDurationMs(3_720_000)).toBe("1h 02m");
    expect(formatDurationMs(-5)).toBe("—");
  });

  it("formats duration between timestamps and tolerates nulls", () => {
    expect(formatDurationBetween("2026-08-03T00:00:00.000Z", "2026-08-03T00:00:46.000Z")).toBe(
      "46s",
    );
    expect(formatDurationBetween(null, "2026-08-03T00:00:46.000Z")).toBe("—");
  });

  it("sums provider call costs and reports null when unknown", () => {
    expect(formatCostUsd(["0.010", "0.005"])).toBe("$0.015");
    expect(formatCostUsd(["1.25", null])).toBe("$1.25");
    expect(formatCostUsd([null])).toBeNull();
    expect(formatCostUsd([])).toBeNull();
  });
});
