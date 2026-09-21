import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  deriveTopology,
  type ReducerGraphState,
  type ReducerNode,
  type ReducerRawFact,
} from "@intenttrace/intent-reducer";
import { RawTraceEventInputSchema } from "@intenttrace/schema";

const recordedEvents = readFileSync(
  new URL("../../test-fixtures/fixtures/demo/imo-2025-p1-parallel-solve.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => RawTraceEventInputSchema.parse(JSON.parse(line)));

function uuid(label: string): string {
  const index = [...label].reduce(
    (value, character) => (value * 31 + character.codePointAt(0)!) % 0xffffffffffff,
    1,
  );
  return `11111111-1111-4111-8111-${index.toString(16).padStart(12, "0")}`;
}

function reducerFact(event: (typeof recordedEvents)[number], index: number): ReducerRawFact {
  return {
    eventId: uuid(`event-${index}`),
    sourceKind: event.source.kind,
    adapterVersion: event.source.adapterVersion,
    sourceEventId: event.source.sourceEventId,
    ingestSeq: String(index + 1),
    kind: event.kind,
    status: event.status,
    agentId: event.agentId ?? null,
    spanId: event.spanId ?? null,
    parentSpanId: event.parentSpanId ?? null,
    causationEventId: null,
    artifactRefs: event.artifactRefs,
    ...(typeof event.attributes.parentAgentId === "string"
      ? { parentAgentId: event.attributes.parentAgentId }
      : {}),
    ...(Array.isArray(event.attributes.spawnedAgentIds)
      ? { spawnedAgentIds: event.attributes.spawnedAgentIds as string[] }
      : {}),
    ...(Array.isArray(event.attributes.joinedAgentIds)
      ? { joinedAgentIds: event.attributes.joinedAgentIds as string[] }
      : {}),
    ...(typeof event.attributes.joinedBy === "string"
      ? { joinedBy: event.attributes.joinedBy }
      : {}),
    ...(typeof event.attributes.onBehalfOf === "string"
      ? { onBehalfOf: event.attributes.onBehalfOf }
      : {}),
    ...(typeof event.attributes.assignedBy === "string"
      ? { assignedBy: event.attributes.assignedBy }
      : {}),
  };
}

function nodeForFact(
  fact: ReducerRawFact,
  logicalNodeId: string,
  kind: ReducerNode["kind"],
): ReducerNode {
  return {
    logicalNodeId,
    versionId: uuid(`version-${logicalNodeId}`),
    kind,
    status: "active",
    title: `Recorded ${fact.sourceEventId}`,
    claims: [
      {
        kind: kind === "request" ? "intent" : kind === "result" ? "outcome" : "action",
        text: `Evidence ${fact.sourceEventId}`,
        provenance: "stated",
        confidence: "high",
        evidenceEventIds: [fact.eventId],
      },
    ],
    primaryParentId: null,
    primaryAgentId: fact.agentId,
    participantAgentIds: fact.agentId ? [fact.agentId] : [],
    artifactIds: [],
    pinnedByHuman: false,
    startedAt: null,
    endedAt: null,
    layout: null,
  };
}

describe("recorded demo reducer acceptance", () => {
  it("derives eight-spoke fan-out and fan-in without fabricating endpoints", () => {
    const facts = recordedEvents.map(reducerFact);
    const request = facts.find(
      (fact) => fact.agentId === "Orchestrator" && fact.kind === "user_message",
    );
    const dispatch = facts.find(
      (fact) => fact.agentId === "Orchestrator" && fact.spawnedAgentIds?.length === 3,
    );
    const convergence = [...facts]
      .reverse()
      .find((fact) => fact.agentId === "Orchestrator" && fact.joinedAgentIds?.length === 2);
    const starts = facts.filter((fact) => fact.kind === "agent_start");
    const ends = facts.filter((fact) => fact.kind === "agent_end");
    if (!request || !dispatch || !convergence) throw new Error("recorded topology facts missing");

    const nodes: ReducerNode[] = [
      nodeForFact(request, uuid("request"), "request"),
      nodeForFact(dispatch, uuid("dispatch"), "work"),
      nodeForFact(convergence, uuid("convergence"), "work"),
      ...starts.map((fact, index) => nodeForFact(fact, uuid(`start-${index}`), "work")),
      ...ends.map((fact, index) => nodeForFact(fact, uuid(`end-${index}`), "result")),
    ];
    const state: ReducerGraphState = { nodes, edges: [] };
    const result = deriveTopology(state, {
      traceId: recordedEvents[0]!.traceId,
      eventWatermark: String(facts.length),
      facts,
      capabilities: new Map([
        [
          `jsonl${String.fromCharCode(0)}1.0.0`,
          {
            spawn: "passthrough",
            join: "passthrough",
            peerMessages: "passthrough",
            input: "single-file",
            laneKey: "agentId",
            limits: [],
          },
        ],
      ]),
      registeredArtifactIds: new Set(),
    });
    const active = result.state.edges.filter((edge) => !edge.retired);
    const spawn = active.filter((edge) => edge.kind === "decomposes_to");
    const joins = active.filter((edge) => edge.kind === "hands_off_to");
    const outgoing = Object.values(Object.groupBy(spawn, (edge) => edge.sourceNodeId));
    const incoming = Object.values(Object.groupBy(joins, (edge) => edge.targetNodeId));

    expect(spawn).toHaveLength(8);
    expect(joins).toHaveLength(8);
    expect(outgoing.some((edges) => (edges?.length ?? 0) > 1)).toBe(true);
    expect(incoming.some((edges) => (edges?.length ?? 0) > 1)).toBe(true);
    expect(active.every((edge) => edge.evidenceEventIds.length > 0)).toBe(true);
    expect(active.every((edge) => edge.provenance === "stated")).toBe(true);
  });
});
