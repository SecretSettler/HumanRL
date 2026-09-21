import { beforeEach, describe, expect, it } from "vitest";

import { useWorkbenchStore } from "./store";
import type { RawTraceEvent, TraceSnapshot } from "./types";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;

function makeEvent(seq: number, agentId: string, status: "ok" | "error" = "ok"): RawTraceEvent {
  return {
    schemaVersion: "1.0.0",
    id: uuid(seq + 100),
    workspaceId: uuid(1),
    projectId: uuid(2),
    traceId: uuid(3),
    source: {
      kind: "jsonl",
      formatVersion: "1",
      adapterVersion: "1",
      sourceInstanceId: "s",
      sourceEventId: `e${seq}`,
    },
    ingestSeq: String(seq),
    occurredAt: new Date(Date.parse("2026-08-03T00:00:00Z") + seq * 1000).toISOString(),
    ingestedAt: new Date(Date.parse("2026-08-03T00:00:00Z") + seq * 1000).toISOString(),
    kind: "log",
    name: `event ${seq}`,
    status,
    agentId,
    artifactRefs: [],
    attributes: {},
  };
}

function makeSnapshot(): TraceSnapshot {
  return {
    trace: {
      id: uuid(3),
      projectId: uuid(2),
      title: "t",
      status: "active",
      eventCount: "1",
      latestIngestSeq: "1",
      latestRevisionId: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:01.000Z",
    },
    raw: { events: [makeEvent(1, "alpha")], nextCursor: null },
    agents: [
      {
        agentId: "alpha",
        displayName: "Alpha",
        eventIds: [makeEvent(1, "alpha").id],
        startedAt: makeEvent(1, "alpha").occurredAt,
        endedAt: makeEvent(1, "alpha").occurredAt,
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

describe("workbench store appendEvents", () => {
  beforeEach(() => {
    useWorkbenchStore.getState().reset();
    useWorkbenchStore.getState().setSnapshot(makeSnapshot());
  });

  it("appends new events, advances watermark, and follows the playhead when live", () => {
    expect(useWorkbenchStore.getState().playhead).toBe(1);
    useWorkbenchStore.getState().appendEvents([makeEvent(3, "beta"), makeEvent(2, "alpha")]);
    const state = useWorkbenchStore.getState();
    expect(state.snapshot?.raw.events.map((event) => event.ingestSeq)).toEqual(["1", "2", "3"]);
    expect(state.snapshot?.trace.latestIngestSeq).toBe("3");
    expect(state.playhead).toBe(3);
  });

  it("deduplicates already-known events", () => {
    useWorkbenchStore.getState().appendEvents([makeEvent(1, "alpha")]);
    expect(useWorkbenchStore.getState().snapshot?.raw.events).toHaveLength(1);
  });

  it("keeps a scrubbed playhead in place", () => {
    useWorkbenchStore.getState().setPlayhead(0);
    useWorkbenchStore.getState().appendEvents([makeEvent(2, "alpha")]);
    expect(useWorkbenchStore.getState().playhead).toBe(0);
  });

  it("extends existing lanes and creates lanes for new agents", () => {
    useWorkbenchStore
      .getState()
      .appendEvents([makeEvent(2, "alpha", "error"), makeEvent(3, "gamma")]);
    const agents = useWorkbenchStore.getState().snapshot?.agents ?? [];
    const alpha = agents.find((lane) => lane.agentId === "alpha");
    expect(alpha?.eventIds).toHaveLength(2);
    expect(alpha?.errorCount).toBe(1);
    expect(agents.some((lane) => lane.agentId === "gamma")).toBe(true);
  });
});
