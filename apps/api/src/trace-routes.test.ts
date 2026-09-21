import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  SchemaVersion,
  type RawTraceEventInput,
  type SemanticGraphSnapshot,
} from "@intenttrace/schema";

import { buildApp } from "./app.js";
import type { ApiServices } from "./services.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const traceId = "33333333-3333-4333-8333-333333333333";
const eventInput: RawTraceEventInput = {
  schemaVersion: SchemaVersion,
  workspaceId,
  projectId,
  traceId,
  source: {
    kind: "jsonl",
    formatVersion: "1.0.0",
    adapterVersion: "1.0.0",
    sourceInstanceId: "test",
    sourceEventId: "event-1",
  },
  occurredAt: "2026-08-03T00:00:00.000Z",
  kind: "user_message",
  name: "Start trace",
  status: "ok",
  artifactRefs: [],
  attributes: {},
  payload: { safe: true },
};
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function services(
  order: string[],
  overrides: Partial<ApiServices["repository"]> = {},
): ApiServices {
  let sequence = 0;
  return {
    repository: {
      ensureTrace: async () => {
        order.push("ensureTrace");
      },
      registerArtifact: async (input) => {
        order.push("registerArtifact");
        return { id: "44444444-4444-4444-8444-444444444444", redacted: false, ...input };
      },
      getArtifact: async () => {
        throw new Error("unused");
      },
      ingest: async (input) => {
        order.push("ingest");
        sequence += 1;
        const event = { ...input };
        delete event.workspaceName;
        delete event.projectName;
        delete event.traceTitle;
        delete event.payload;
        return {
          event: {
            ...event,
            id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
            ingestSeq: String(sequence),
            ingestedAt: "2026-08-03T00:00:01.000Z",
          },
          duplicate: false,
          traceStale: false,
          warnings: [],
        };
      },
      listTraces: async () => ({ traces: [], nextCursor: null }),
      listTracesByIds: async () => [],
      getTrace: async () => {
        throw new Error("unused");
      },
      listRawEvents: async () => ({ events: [], nextCursor: null }),
      getAgentTimeline: async () => [],
      listStreamEvents: async () => [],
      getStreamBounds: async () => ({ earliest: null, latest: null }),
      listProviderCalls: async () => [],
      listRevisions: async () => [],
      getGraph: async () => null,
      getObservedTopology: async () => ({
        observed: { lanes: 0, lanesWithParent: 0, spawnEdges: 0, peerEdges: 0 },
        sources: [],
      }),
      editSemanticNode: async () => {
        throw new Error("unused");
      },
      deleteTraceData: async () => undefined,
      ...overrides,
    },
    artifactStore: {
      put: async (input) => {
        order.push("putArtifact");
        return {
          traceId: input.traceId,
          sha256: "a".repeat(64),
          byteLength: input.bytes.byteLength,
          mediaType: input.mediaType,
        };
      },
      stat: async () => null,
      getRange: async () => new Uint8Array(),
      deleteTrace: async () => undefined,
    },
  } as ApiServices;
}

describe("trace API integration boundary", () => {
  it("establishes the trace before registering the first payload artifact", async () => {
    const order: string[] = [];
    const app = buildApp({ services: services(order) });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/events",
      payload: eventInput,
    });
    expect(response.statusCode).toBe(201);
    expect(order).toEqual(["ensureTrace", "putArtifact", "registerArtifact", "ingest"]);
    expect(response.json().event.payloadRef.sha256).toBe("a".repeat(64));
  });

  it("accepts gzip OTLP HTTP JSON and returns partial-success shape", async () => {
    const order: string[] = [];
    const app = buildApp({ services: services(order) });
    apps.push(app);
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "0af7651916cd43dd8448eb211c80319c",
                  spanId: "b7ad6b7169203331",
                  name: "test-span",
                  kind: 1,
                  startTimeUnixNano: "1785715200000000000",
                  endTimeUnixNano: "1785715201000000000",
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      payload: gzipSync(JSON.stringify(payload)),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ partialSuccess: { rejectedSpans: 0, errorMessage: "" } });
    expect(order).toContain("ingest");
  });

  it("returns declared and observed topology in trace snapshots", async () => {
    const order: string[] = [];
    const app = buildApp({
      services: services(order, {
        getTrace: async () => ({
          id: traceId,
          projectId,
          title: "Topology trace",
          status: "active",
          eventCount: "2",
          latestIngestSeq: "2",
          latestRevisionId: null,
          createdAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:01.000Z",
        }),
        getObservedTopology: async () => ({
          observed: { lanes: 2, lanesWithParent: 1, spawnEdges: 1, peerEdges: 0 },
          sources: [{ sourceKind: "jsonl", adapterVersion: "1.0.0" }],
        }),
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/traces/${traceId}/snapshot`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().topology).toEqual({
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
      observed: { lanes: 2, lanesWithParent: 1, spawnEdges: 1, peerEdges: 0 },
    });
  });

  it("returns audited semantic edge evidence and provenance", async () => {
    const evidenceEventId = "55555555-5555-4555-8555-555555555555";
    const graph: SemanticGraphSnapshot = {
      revision: {
        id: "66666666-6666-4666-8666-666666666666",
        traceId,
        parentRevisionId: null,
        branchKind: "live",
        eventWatermark: "2",
        createdAt: "2026-08-03T00:00:02.000Z",
        sourceJobId: null,
        stale: false,
      },
      nodes: [],
      edges: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          logicalEdgeId: "88888888-8888-4888-8888-888888888888",
          traceId,
          sourceNodeId: projectId,
          targetNodeId: workspaceId,
          kind: "decomposes_to",
          retired: false,
          evidenceEventIds: [evidenceEventId],
          provenance: "stated",
        },
      ],
    };
    const app = buildApp({ services: services([], { getGraph: async () => graph }) });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/traces/${traceId}/graph`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().edges[0]).toMatchObject({
      evidenceEventIds: [evidenceEventId],
      provenance: "stated",
    });
  });

  it("returns the recorded demo fan-out, fan-in, edge evidence, and observed topology", async () => {
    const dispatchNode = "99999999-9999-4999-8999-999999999901";
    const convergenceNode = "99999999-9999-4999-8999-999999999902";
    const graph: SemanticGraphSnapshot = {
      revision: {
        id: "99999999-9999-4999-8999-999999999903",
        traceId,
        parentRevisionId: null,
        branchKind: "final",
        eventWatermark: "691",
        createdAt: "2026-08-12T14:40:00.000Z",
        sourceJobId: null,
        stale: false,
      },
      nodes: [],
      edges: [
        ...[1, 2].map((index) => ({
          id: `99999999-9999-4999-8999-9999999999${String(index).padStart(2, "0")}`,
          logicalEdgeId: `88888888-8888-4888-8888-8888888888${String(index).padStart(2, "0")}`,
          traceId,
          sourceNodeId: dispatchNode,
          targetNodeId: `77777777-7777-4777-8777-7777777777${String(index).padStart(2, "0")}`,
          kind: "decomposes_to" as const,
          retired: false,
          evidenceEventIds: [`66666666-6666-4666-8666-6666666666${String(index).padStart(2, "0")}`],
          provenance: "stated" as const,
        })),
        ...[3, 4].map((index) => ({
          id: `99999999-9999-4999-8999-9999999999${String(index).padStart(2, "0")}`,
          logicalEdgeId: `88888888-8888-4888-8888-8888888888${String(index).padStart(2, "0")}`,
          traceId,
          sourceNodeId: `77777777-7777-4777-8777-7777777777${String(index).padStart(2, "0")}`,
          targetNodeId: convergenceNode,
          kind: "hands_off_to" as const,
          retired: false,
          evidenceEventIds: [`66666666-6666-4666-8666-6666666666${String(index).padStart(2, "0")}`],
          provenance: "stated" as const,
        })),
      ],
    };
    const app = buildApp({
      services: services([], {
        getTrace: async () => ({
          id: traceId,
          projectId,
          title: "IMO 2025 P1 solved by eight parallel agents",
          status: "completed",
          eventCount: "691",
          latestIngestSeq: "691",
          latestRevisionId: graph.revision.id,
          createdAt: "2026-08-12T14:15:39.264Z",
          updatedAt: "2026-08-12T14:40:00.000Z",
        }),
        getGraph: async () => graph,
        getObservedTopology: async () => ({
          observed: { lanes: 9, lanesWithParent: 8, spawnEdges: 8, peerEdges: 0 },
          sources: [{ sourceKind: "jsonl", adapterVersion: "1.0.0" }],
        }),
      }),
    });
    apps.push(app);

    const [graphResponse, snapshotResponse] = await Promise.all([
      app.inject({ method: "GET", url: `/api/v1/traces/${traceId}/graph` }),
      app.inject({ method: "GET", url: `/api/v1/traces/${traceId}/snapshot` }),
    ]);
    expect(graphResponse.statusCode).toBe(200);
    const returnedEdges = graphResponse.json().edges as SemanticGraphSnapshot["edges"];
    const outgoing = Object.values(Object.groupBy(returnedEdges, (edge) => edge.sourceNodeId));
    const incoming = Object.values(Object.groupBy(returnedEdges, (edge) => edge.targetNodeId));
    expect(outgoing.some((edges) => (edges?.length ?? 0) > 1)).toBe(true);
    expect(incoming.some((edges) => (edges?.length ?? 0) > 1)).toBe(true);
    expect(returnedEdges.every((edge) => edge.evidenceEventIds.length > 0)).toBe(true);
    expect(returnedEdges.every((edge) => edge.provenance === "stated")).toBe(true);
    expect(snapshotResponse.statusCode).toBe(200);
    expect(snapshotResponse.json().topology.observed).toEqual({
      lanes: 9,
      lanesWithParent: 8,
      spawnEdges: 8,
      peerEdges: 0,
    });
  });
});
