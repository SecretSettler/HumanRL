import { describe, expect, it } from "vitest";

import { SchemaVersion, type TopologyCapability } from "@intenttrace/schema";

import {
  deriveTopology,
  validateProviderPatch,
  type ReducerGraphState,
  type ReducerRawFact,
} from "../src/index.js";

const eventId = "019fbbb3-4324-7d43-8f9c-cd489a92cb28";
const revisionId = "019fbbb3-4324-7d43-8f9c-cd489a92cb29";
const nonce = "019fbbb3-4324-7d43-8f9c-cd489a92cb30";

const context = {
  expectedBaseRevisionId: revisionId,
  expectedJobNonce: nonce,
  allowedEventIds: new Set([eventId]),
  allowedArtifactIds: new Set<string>(),
  allowedAgentIds: new Set<string>(),
  allowedNodeIds: new Set<string>(),
  allowedEdgeIds: new Set<string>(),
  pinnedNodeIds: new Set<string>(),
};

describe("provider patch trust boundary", () => {
  it("accepts an empty, nonce-bound mock patch", () => {
    const result = validateProviderPatch(
      {
        schemaVersion: SchemaVersion,
        jobNonce: nonce,
        baseRevisionId: revisionId,
        operations: [],
        diagnostics: [],
      },
      context,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects evidence outside the job allowlist", () => {
    const result = validateProviderPatch(
      {
        schemaVersion: SchemaVersion,
        jobNonce: nonce,
        baseRevisionId: revisionId,
        operations: [
          {
            op: "add_node",
            ref: "tmp:1",
            node: {
              kind: "work",
              title: "Normalize source events",
              claims: [
                {
                  kind: "action",
                  text: "Normalized an event",
                  provenance: "inferred",
                  suggestedConfidence: "low",
                  evidenceEventIds: ["019fbbb3-4324-7d43-8f9c-cd489a92cb99"],
                },
              ],
            },
          },
        ],
        diagnostics: [],
      },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.some((issue) => issue.code === "unknown_evidence")).toBe(true);
  });
});

describe("topology derivation boundaries", () => {
  const capability: TopologyCapability = {
    spawn: "passthrough",
    join: "unsupported",
    peerMessages: "unsupported",
    input: "single-file",
    laneKey: "agentId",
    limits: [],
  };
  const state: ReducerGraphState = {
    nodes: [
      {
        logicalNodeId: "019fbbb3-4324-7d43-8f9c-cd489a92cc01",
        versionId: "019fbbb3-4324-7d43-8f9c-cd489a92cd01",
        kind: "request",
        status: "active",
        title: "Root request",
        claims: [
          {
            kind: "intent",
            text: "Root evidence",
            provenance: "stated",
            confidence: "high",
            evidenceEventIds: ["019fbbb3-4324-7d43-8f9c-cd489a92ce01"],
          },
        ],
        primaryParentId: null,
        primaryAgentId: "root",
        participantAgentIds: ["root"],
        artifactIds: [],
        pinnedByHuman: true,
        startedAt: null,
        endedAt: null,
        layout: null,
      },
      {
        logicalNodeId: "019fbbb3-4324-7d43-8f9c-cd489a92cc02",
        versionId: "019fbbb3-4324-7d43-8f9c-cd489a92cd02",
        kind: "work",
        status: "active",
        title: "Child work",
        claims: [
          {
            kind: "action",
            text: "Child evidence",
            provenance: "stated",
            confidence: "high",
            evidenceEventIds: ["019fbbb3-4324-7d43-8f9c-cd489a92ce02"],
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
      },
    ],
    edges: [],
  };
  const facts: ReducerRawFact[] = [
    {
      eventId: "019fbbb3-4324-7d43-8f9c-cd489a92ce01",
      sourceKind: "jsonl",
      adapterVersion: "test",
      sourceEventId: "root-event",
      ingestSeq: "1",
      kind: "user_message",
      status: "ok",
      agentId: "root",
      spanId: null,
      parentSpanId: null,
      causationEventId: null,
      artifactRefs: [],
    },
    {
      eventId: "019fbbb3-4324-7d43-8f9c-cd489a92ce02",
      sourceKind: "jsonl",
      adapterVersion: "test",
      sourceEventId: "child-start",
      ingestSeq: "2",
      kind: "agent_start",
      status: "ok",
      agentId: "child",
      spanId: null,
      parentSpanId: null,
      causationEventId: null,
      artifactRefs: [],
      parentAgentId: "root",
    },
  ];

  it("preserves pinned parents while deriving unpinned node fields", () => {
    const pinnedParent = "019fbbb3-4324-7d43-8f9c-cd489a92cc99";
    const result = deriveTopology(
      {
        ...state,
        nodes: [{ ...state.nodes[0]!, primaryParentId: pinnedParent }, state.nodes[1]!],
      },
      {
        traceId: "019fbbb3-4324-7d43-8f9c-cd489a92cb20",
        eventWatermark: "2",
        facts,
        capabilities: new Map([["jsonl\0test", capability]]),
        registeredArtifactIds: new Set(),
      },
    );
    expect(result.state.nodes[0]?.primaryParentId).toBe(pinnedParent);
    expect(result.state.nodes[1]).toMatchObject({
      primaryParentId: state.nodes[0]?.logicalNodeId,
      primaryAgentId: "child",
      participantAgentIds: ["child"],
    });
    expect(result.state.edges).toEqual([]);
  });

  it("omits passthrough spawn edges without both structured parent facts", () => {
    const result = deriveTopology(state, {
      traceId: "019fbbb3-4324-7d43-8f9c-cd489a92cb20",
      eventWatermark: "2",
      facts,
      capabilities: new Map([["jsonl\0test", capability]]),
      registeredArtifactIds: new Set(),
    });
    expect(result.state.edges).toEqual([]);
  });
});
