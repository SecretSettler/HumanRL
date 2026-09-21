import { describe, expect, it } from "vitest";

import { SchemaVersion, type TopologyCapability } from "@intenttrace/schema";

import {
  applyProviderPatch,
  deriveTopology,
  type ReducerGraphState,
  type ReducerRawFact,
  type ReducerTopologyContext,
} from "../src/index.js";

const traceId = "019fbbb3-4324-7d43-8f9c-cd489a92cb20";
const revisionId = "019fbbb3-4324-7d43-8f9c-cd489a92cb29";
const nonce = "019fbbb3-4324-7d43-8f9c-cd489a92cb30";
const otherNonce = "019fbbb3-4324-7d43-8f9c-cd489a92cb40";
const requestNode = "019fbbb3-4324-7d43-8f9c-cd489a92c001";
const dispatchNode = "019fbbb3-4324-7d43-8f9c-cd489a92c002";
const childFirstA = "019fbbb3-4324-7d43-8f9c-cd489a92c003";
const childLastA = "019fbbb3-4324-7d43-8f9c-cd489a92c004";
const childFirstB = "019fbbb3-4324-7d43-8f9c-cd489a92c005";
const childLastB = "019fbbb3-4324-7d43-8f9c-cd489a92c006";
const convergenceNode = "019fbbb3-4324-7d43-8f9c-cd489a92c007";

const eventIds = {
  request: "019fbbb3-4324-7d43-8f9c-cd489a92d001",
  dispatch: "019fbbb3-4324-7d43-8f9c-cd489a92d009",
  childStartA: "019fbbb3-4324-7d43-8f9c-cd489a92d008",
  childStartB: "019fbbb3-4324-7d43-8f9c-cd489a92d007",
  childEndA: "019fbbb3-4324-7d43-8f9c-cd489a92d006",
  childEndB: "019fbbb3-4324-7d43-8f9c-cd489a92d005",
  convergence: "019fbbb3-4324-7d43-8f9c-cd489a92d004",
} as const;

const capability: TopologyCapability = {
  spawn: "stated",
  join: "stated",
  peerMessages: "stated",
  input: "single-file",
  laneKey: "agentId",
  limits: [],
};

function claim(eventId: string) {
  return {
    kind: "action" as const,
    text: `Evidence ${eventId}`,
    provenance: "stated" as const,
    confidence: "high" as const,
    evidenceEventIds: [eventId],
  };
}

function node(
  logicalNodeId: string,
  eventId: string,
  kind: "request" | "work" | "result" = "work",
) {
  return {
    logicalNodeId,
    versionId: logicalNodeId.replace("c00", "e00"),
    kind,
    status: "active" as const,
    title: `Node ${logicalNodeId}`,
    claims: [claim(eventId)],
    primaryParentId: null,
    primaryAgentId: null,
    participantAgentIds: [],
    artifactIds: [],
    pinnedByHuman: false,
    startedAt: null,
    endedAt: null,
    layout: null,
  };
}

function fact(
  eventId: string,
  ingestSeq: number,
  kind: string,
  agentId: string,
  attributes: Partial<ReducerRawFact> = {},
): ReducerRawFact {
  return {
    eventId,
    sourceKind: "jsonl",
    adapterVersion: "test",
    sourceEventId: `source-${ingestSeq}`,
    ingestSeq: String(ingestSeq),
    kind,
    status: "ok",
    agentId,
    spanId: null,
    parentSpanId: null,
    causationEventId: null,
    artifactRefs: [],
    ...attributes,
  };
}

const fanState: ReducerGraphState = {
  nodes: [
    node(requestNode, eventIds.request, "request"),
    node(dispatchNode, eventIds.dispatch),
    node(childFirstA, eventIds.childStartA),
    node(childLastA, eventIds.childEndA, "result"),
    node(childFirstB, eventIds.childStartB),
    node(childLastB, eventIds.childEndB, "result"),
    node(convergenceNode, eventIds.convergence),
  ],
  edges: [],
};

const fanFacts: ReducerRawFact[] = [
  fact(eventIds.request, 1, "user_message", "root"),
  fact(eventIds.dispatch, 2, "agent_handoff", "root", {
    spanId: "dispatch-call",
    spawnedAgentIds: ["child-a", "child-b"],
  }),
  fact(eventIds.childStartA, 3, "agent_start", "child-a", {
    parentAgentId: "root",
    parentSpanId: "dispatch-call",
  }),
  fact(eventIds.childStartB, 4, "agent_start", "child-b", {
    parentAgentId: "root",
    parentSpanId: "dispatch-call",
    topologyProvenance: "inferred",
  }),
  fact(eventIds.childEndA, 5, "agent_end", "child-a"),
  fact(eventIds.childEndB, 6, "agent_end", "child-b", {
    topologyProvenance: "inferred",
  }),
  fact(eventIds.convergence, 7, "tool_result", "root", {
    joinedAgentIds: ["child-a", "child-b"],
  }),
];

function topologyContext(
  facts: readonly ReducerRawFact[] = fanFacts,
  registeredArtifactIds: ReadonlySet<string> = new Set(),
): ReducerTopologyContext {
  return {
    traceId,
    eventWatermark: "20",
    facts,
    capabilities: new Map([["jsonl\0test", capability]]),
    registeredArtifactIds,
  };
}

function validationContext(state: ReducerGraphState, jobNonce = nonce) {
  return {
    expectedBaseRevisionId: revisionId,
    expectedJobNonce: jobNonce,
    allowedEventIds: new Set(fanFacts.map((item) => item.eventId)),
    allowedArtifactIds: new Set<string>(),
    allowedAgentIds: new Set(["root", "child-a", "child-b"]),
    allowedNodeIds: new Set(state.nodes.map((item) => item.logicalNodeId)),
    allowedEdgeIds: new Set(state.edges.map((item) => item.logicalEdgeId)),
    pinnedNodeIds: new Set(
      state.nodes.filter((item) => item.pinnedByHuman).map((item) => item.logicalNodeId),
    ),
  };
}

describe("deterministic reducer properties", () => {
  it("derives a stable fan-out/fan-in DAG without an ingest-order sibling chain", () => {
    const first = deriveTopology(fanState, topologyContext());
    const active = first.state.edges.filter((edge) => !edge.retired);
    const spawn = active.filter((edge) => edge.kind === "decomposes_to");
    const joins = active.filter((edge) => edge.kind === "hands_off_to");

    expect(spawn.map((edge) => [edge.sourceNodeId, edge.targetNodeId])).toEqual([
      [dispatchNode, childFirstA],
      [dispatchNode, childFirstB],
    ]);
    expect(joins.map((edge) => [edge.sourceNodeId, edge.targetNodeId])).toEqual([
      [childLastA, convergenceNode],
      [childLastB, convergenceNode],
    ]);
    expect(spawn.map((edge) => edge.provenance)).toEqual(["stated", "inferred"]);
    expect(joins.map((edge) => edge.provenance)).toEqual(["stated", "inferred"]);
    expect(active.every((edge) => edge.sourceNodeId !== edge.targetNodeId)).toBe(true);
    expect(
      active.some(
        (edge) =>
          (edge.sourceNodeId === childFirstA && edge.targetNodeId === childFirstB) ||
          (edge.sourceNodeId === childFirstB && edge.targetNodeId === childFirstA),
      ),
    ).toBe(false);
    expect(new Set(active.map((edge) => edge.logicalEdgeId)).size).toBe(active.length);
    expect(
      active.every(
        (edge) =>
          JSON.stringify(edge.evidenceEventIds) ===
          JSON.stringify([...edge.evidenceEventIds].sort()),
      ),
    ).toBe(true);

    const operations = [
      {
        op: "update_node" as const,
        ref: childFirstA,
        set: { title: "Child A start" },
        evidenceEventIds: [eventIds.childStartA],
      },
      {
        op: "update_node" as const,
        ref: childFirstB,
        set: { title: "Child B start" },
        evidenceEventIds: [eventIds.childStartB],
      },
    ];
    const appliedFirst = applyProviderPatch(
      {
        schemaVersion: SchemaVersion,
        jobNonce: nonce,
        baseRevisionId: revisionId,
        operations,
        diagnostics: [],
      },
      fanState,
      validationContext(fanState),
      topologyContext(),
    );
    const appliedSecond = applyProviderPatch(
      {
        schemaVersion: SchemaVersion,
        jobNonce: otherNonce,
        baseRevisionId: revisionId,
        operations: [...operations].reverse(),
        diagnostics: [],
      },
      fanState,
      validationContext(fanState, otherNonce),
      topologyContext(),
    );
    expect(appliedFirst.ok).toBe(true);
    expect(appliedSecond.ok).toBe(true);
    if (appliedFirst.ok && appliedSecond.ok) {
      expect(appliedFirst.state.edges.map((edge) => edge.logicalEdgeId)).toEqual(
        appliedSecond.state.edges.map((edge) => edge.logicalEdgeId),
      );
    }
  });

  it("retires and reactivates a derived edge under its stable logical identity", () => {
    const initial = deriveTopology(fanState, topologyContext());
    const withoutSecondChild = deriveTopology(
      initial.state,
      topologyContext(
        fanFacts.filter(
          (item) => item.eventId !== eventIds.childStartB && item.eventId !== eventIds.childEndB,
        ),
      ),
    );
    const initialEdge = initial.state.edges.find(
      (edge) => edge.kind === "decomposes_to" && edge.targetNodeId === childFirstB,
    );
    const retiredEdge = withoutSecondChild.state.edges.find(
      (edge) => edge.logicalEdgeId === initialEdge?.logicalEdgeId,
    );
    expect(retiredEdge?.retired).toBe(true);
    expect(retiredEdge?.evidenceEventIds).toEqual(initialEdge?.evidenceEventIds);
    expect(retiredEdge?.provenance).toBe(initialEdge?.provenance);

    const restored = deriveTopology(withoutSecondChild.state, topologyContext());
    const restoredEdge = restored.state.edges.find(
      (edge) => edge.logicalEdgeId === initialEdge?.logicalEdgeId,
    );
    expect(restoredEdge?.retired).toBe(false);
    expect(restoredEdge?.versionId).not.toBe(retiredEdge?.versionId);
  });

  it("uses the lane's first qualifying start fact for parentage even outside node evidence", () => {
    const childEvidence = "019fbbb3-4324-7d43-8f9c-cd489a92d020";
    const childNode = node(childFirstA, childEvidence);
    const state: ReducerGraphState = {
      nodes: [
        node(requestNode, eventIds.request, "request"),
        node(dispatchNode, eventIds.dispatch),
        childNode,
      ],
      edges: [],
    };
    const facts = [
      fact(eventIds.request, 1, "user_message", "root"),
      fact(eventIds.dispatch, 2, "agent_handoff", "root", {
        spanId: "dispatch-call",
        spawnedAgentIds: ["child-a"],
      }),
      fact(eventIds.childStartA, 3, "agent_start", "child-a", {
        parentAgentId: "root",
        parentSpanId: "dispatch-call",
      }),
      fact(childEvidence, 4, "assistant_message", "child-a"),
    ];
    const result = deriveTopology(state, topologyContext(facts));
    expect(
      result.state.nodes.find((item) => item.logicalNodeId === childFirstA)?.primaryParentId,
    ).toBe(dispatchNode);
  });

  it("rejects colliding spawn facts from a different parent lane and source", () => {
    const collision = fact(
      "019fbbb3-4324-7d43-8f9c-cd489a92d021",
      1,
      "agent_handoff",
      "other-parent",
      {
        sourceKind: "otlp",
        adapterVersion: "1.0.0",
        spanId: "dispatch-call",
        spawnedAgentIds: ["child-a"],
      },
    );
    const context = topologyContext([collision, ...fanFacts]);
    context.capabilities = new Map([
      ["jsonl\0test", capability],
      [`otlp${String.fromCharCode(0)}1.0.0`, capability],
    ]);
    const result = deriveTopology(fanState, context);
    const spawn = result.state.edges.find(
      (edge) => edge.kind === "decomposes_to" && edge.targetNodeId === childFirstA,
    );
    expect(spawn?.sourceNodeId).toBe(dispatchNode);
    expect(spawn?.evidenceEventIds).toContain(eventIds.dispatch);
    expect(spawn?.evidenceEventIds).not.toContain(collision.eventId);
  });

  it("copies only registered artifacts and includes the beneficiary as a dependency consumer", () => {
    const artifact = "019fbbb3-4324-7d43-8f9c-cd489a92af01";
    const unknown = "019fbbb3-4324-7d43-8f9c-cd489a92af02";
    const producerEvent = "019fbbb3-4324-7d43-8f9c-cd489a92d022";
    const consumerEvent = "019fbbb3-4324-7d43-8f9c-cd489a92d023";
    const producer = { ...node(dispatchNode, producerEvent), artifactIds: [artifact] };
    const beneficiary = node(childFirstA, consumerEvent);
    const state: ReducerGraphState = { nodes: [producer, beneficiary], edges: [] };
    const facts = [
      fact(producerEvent, 1, "file_write", "root", {
        artifactRefs: [artifact, unknown],
        onBehalfOf: "child-a",
      }),
      fact(consumerEvent, 2, "assistant_message", "child-a", { artifactRefs: [artifact, unknown] }),
    ];
    const result = deriveTopology(state, topologyContext(facts, new Set([artifact])));
    expect(result.state.nodes.map((item) => item.artifactIds)).toEqual([[artifact], [artifact]]);
    expect(result.state.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "produces",
          sourceNodeId: dispatchNode,
          targetNodeId: childFirstA,
        }),
        expect.objectContaining({
          kind: "depends_on",
          sourceNodeId: childFirstA,
          targetNodeId: dispatchNode,
        }),
      ]),
    );
    expect(result.state.edges.every((edge) => edge.evidenceEventIds.length > 0)).toBe(true);
  });
});
