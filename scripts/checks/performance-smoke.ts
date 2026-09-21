import { performance } from "node:perf_hooks";

import {
  applyProviderPatch,
  type ReducerGraphState,
} from "../../packages/intent-reducer/src/index.js";
import { SchemaVersion } from "../../packages/schema/src/index.js";
import { generateAcceptanceFixture } from "../../packages/test-fixtures/src/index.js";

const started = performance.now();
const events = generateAcceptanceFixture(10_000);
const fixtureMs = performance.now() - started;
if (events.length !== 10_000) throw new Error("10,000-event fixture generation failed");
const eventId = "019fbbb3-4324-7d43-8f9c-cd489a92cb28";
const revisionId = "019fbbb3-4324-7d43-8f9c-cd489a92cb29";
const nonce = "019fbbb3-4324-7d43-8f9c-cd489a92cb30";
const uuid = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const graph: ReducerGraphState = {
  nodes: Array.from({ length: 1500 }, (_, index) => ({
    logicalNodeId: uuid(index),
    versionId: uuid(index + 2000),
    kind: "work" as const,
    status: "active" as const,
    title: `Semantic node ${index}`,
    claims: [
      {
        kind: "action" as const,
        text: `Evidence backed action ${index}`,
        provenance: "stated" as const,
        confidence: "high" as const,
        evidenceEventIds: [eventId],
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
  })),
  edges: [],
};
const reducerStarted = performance.now();
const result = applyProviderPatch(
  {
    schemaVersion: SchemaVersion,
    jobNonce: nonce,
    baseRevisionId: revisionId,
    operations: [],
    diagnostics: ["performance smoke"],
  },
  graph,
  {
    expectedBaseRevisionId: revisionId,
    expectedJobNonce: nonce,
    allowedEventIds: new Set([eventId]),
    allowedArtifactIds: new Set(),
    allowedAgentIds: new Set(),
    allowedNodeIds: new Set(graph.nodes.map((node) => node.logicalNodeId)),
    allowedEdgeIds: new Set(),
    pinnedNodeIds: new Set(),
  },
);
const reducerMs = performance.now() - reducerStarted;
if (!result.ok || result.state.nodes.length !== 1500)
  throw new Error("1,500-node reducer smoke failed");
process.stdout.write(
  JSON.stringify({
    kind: "synthetic_smoke_not_ui_sla",
    rawEvents: events.length,
    semanticNodes: graph.nodes.length,
    fixtureMs: Number(fixtureMs.toFixed(2)),
    reducerMs: Number(reducerMs.toFixed(2)),
  }) + "\n",
);
