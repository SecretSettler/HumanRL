import { describe, expect, it } from "vitest";

import {
  IngestResultSchema,
  ProviderIntentGraphPatchSchema,
  RawTraceEventInputSchema,
  RawTraceEventSchema,
  ReducerDerivedEdgeKindSchema,
  SchemaVersion,
  SemanticEdgeKindSchema,
  SemanticEdgeVersionSchema,
  SemanticRevisionSchema,
  SessionCatalogSchema,
  SessionImportBatchOutcomeSchema,
  SessionImportOutcomeSchema,
  SessionImportSummarySchema,
  SessionUploadCandidateListSchema,
  SessionUploadCandidateRequestSchema,
  TopologyCapabilitySchema,
  TopologyFidelitySchema,
  TraceSnapshotSchema,
  TraceSourceKindSchema,
  TraceTopologySchema,
} from "./index.js";

const ids = {
  event: "019fbbb3-4324-7d43-8f9c-cd489a92cb28",
  workspace: "019fbbb3-4324-7d43-8f9c-cd489a92cb29",
  project: "019fbbb3-4324-7d43-8f9c-cd489a92cb30",
  trace: "019fbbb3-4324-7d43-8f9c-cd489a92cb31",
};

const rawInput = {
  schemaVersion: SchemaVersion,
  workspaceId: ids.workspace,
  projectId: ids.project,
  traceId: ids.trace,
  source: {
    kind: "jsonl" as const,
    formatVersion: "1",
    adapterVersion: "1.0.0",
    sourceInstanceId: "fixture-main",
    sourceEventId: "evt-1",
  },
  occurredAt: "2026-08-01T00:00:00.000Z",
  kind: "user_message" as const,
  name: "request",
  status: "ok" as const,
  artifactRefs: [],
  attributes: {},
};

const persistedEvent = {
  ...rawInput,
  id: ids.event,
  ingestSeq: "1",
  ingestedAt: "2026-08-01T00:00:00.100Z",
};

describe("RawTraceEvent contract", () => {
  it("accepts an immutable canonical envelope", () => {
    expect(
      RawTraceEventSchema.parse({
        schemaVersion: SchemaVersion,
        id: ids.event,
        workspaceId: ids.workspace,
        projectId: ids.project,
        traceId: ids.trace,
        source: {
          kind: "jsonl",
          formatVersion: "1",
          adapterVersion: "0.0.0",
          sourceInstanceId: "fixture-main",
          sourceEventId: "evt-1",
        },
        ingestSeq: "1",
        occurredAt: "2026-08-01T00:00:00.000Z",
        ingestedAt: "2026-08-01T00:00:00.100Z",
        kind: "user_message",
        name: "request",
        status: "ok",
        artifactRefs: [],
        attributes: {},
      }),
    ).toBeTruthy();
  });

  it("rejects floating-point or zero ingest sequences", () => {
    expect(() => RawTraceEventSchema.parse({ ingestSeq: "0" })).toThrow();
  });
});

describe("topology and evidence contracts", () => {
  it("locks source kinds and topology fidelity literals", () => {
    expect(TraceSourceKindSchema.options).toEqual([
      "jsonl",
      "otlp",
      "codex",
      "claude",
      "opencode",
      "omp",
      "grok",
      "pi",
      "custom",
    ]);
    expect(TopologyFidelitySchema.options).toEqual([
      "stated",
      "inferred",
      "passthrough",
      "unsupported",
    ]);
  });

  it("accepts only strict topology declarations and non-negative observations", () => {
    const declared = {
      spawn: "stated" as const,
      join: "inferred" as const,
      peerMessages: "unsupported" as const,
      input: "bundle" as const,
      laneKey: "agentId",
      limits: ["Measured limitation."],
    };
    expect(TopologyCapabilitySchema.parse(declared)).toEqual(declared);
    expect(() => TopologyCapabilitySchema.parse({ ...declared, extra: true })).toThrow();
    expect(
      TraceTopologySchema.parse({
        declared,
        observed: { lanes: 2, lanesWithParent: 1, spawnEdges: 1, peerEdges: 0 },
      }).observed.lanes,
    ).toBe(2);
    expect(() =>
      TraceTopologySchema.parse({
        declared,
        observed: { lanes: -1, lanesWithParent: 0, spawnEdges: 0, peerEdges: 0 },
      }),
    ).toThrow();
  });

  it("requires topology on trace snapshots", () => {
    const snapshot = {
      trace: {
        id: ids.trace,
        projectId: ids.project,
        title: "Fixture trace",
        status: "active" as const,
        eventCount: "1",
        latestIngestSeq: "1",
        latestRevisionId: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.100Z",
      },
      raw: { events: [persistedEvent], nextCursor: null },
      agents: [],
      revision: null,
      topology: {
        declared: {
          spawn: "passthrough" as const,
          join: "passthrough" as const,
          peerMessages: "passthrough" as const,
          input: "single-file" as const,
          laneKey: "agentId",
          limits: [],
        },
        observed: { lanes: 0, lanesWithParent: 0, spawnEdges: 0, peerEdges: 0 },
      },
    };
    expect(TraceSnapshotSchema.parse(snapshot).topology.observed.spawnEdges).toBe(0);
    const withoutTopology = { ...snapshot };
    Reflect.deleteProperty(withoutTopology, "topology");
    expect(TraceSnapshotSchema.safeParse(withoutTopology).success).toBe(false);
  });

  it("keeps producer causation source IDs input-only and reserves repository warnings", () => {
    expect(
      RawTraceEventInputSchema.parse({ ...rawInput, causationSourceEventId: "evt-parent" })
        .causationSourceEventId,
    ).toBe("evt-parent");
    expect(
      RawTraceEventSchema.safeParse({ ...persistedEvent, causationSourceEventId: "evt-parent" })
        .success,
    ).toBe(false);
    expect(
      RawTraceEventInputSchema.safeParse({
        ...rawInput,
        attributes: { intenttraceWarnings: [{ code: "repository-only" }] },
      }).success,
    ).toBe(false);
    expect(
      RawTraceEventSchema.parse({
        ...persistedEvent,
        attributes: { intenttraceWarnings: [{ code: "repository-only" }] },
      }).attributes,
    ).toHaveProperty("intenttraceWarnings");
  });

  it("requires edge evidence and provenance", () => {
    const edge = {
      id: ids.event,
      logicalEdgeId: ids.workspace,
      traceId: ids.trace,
      sourceNodeId: ids.project,
      targetNodeId: ids.workspace,
      kind: "decomposes_to" as const,
      retired: false,
      evidenceEventIds: [ids.event],
      provenance: "stated" as const,
    };
    expect(SemanticEdgeVersionSchema.parse(edge).evidenceEventIds).toEqual([ids.event]);
    expect(SemanticEdgeVersionSchema.safeParse({ ...edge, evidenceEventIds: [] }).success).toBe(
      false,
    );
    const withoutProvenance = { ...edge };
    Reflect.deleteProperty(withoutProvenance, "provenance");
    expect(SemanticEdgeVersionSchema.safeParse(withoutProvenance).success).toBe(false);
  });

  it("requires structured ingest warnings", () => {
    expect(
      IngestResultSchema.parse({
        event: persistedEvent,
        duplicate: false,
        traceStale: false,
        warnings: [{ code: "causation_source_event_unresolved", sourceEventId: "evt-parent" }],
      }).warnings,
    ).toEqual([{ code: "causation_source_event_unresolved", sourceEventId: "evt-parent" }]);
    expect(
      IngestResultSchema.safeParse({
        event: persistedEvent,
        duplicate: false,
        traceStale: false,
      }).success,
    ).toBe(false);
  });

  it("keeps reducer-derived edge kinds a subset of the declared vocabulary", () => {
    const derived = ReducerDerivedEdgeKindSchema.options;
    expect([...derived].sort()).toEqual(
      ["blocks", "decomposes_to", "depends_on", "hands_off_to", "produces"].sort(),
    );
    for (const kind of derived) {
      expect(SemanticEdgeKindSchema.safeParse(kind).success).toBe(true);
    }
    // Reserved names stay parseable for wire compatibility but are not derived.
    for (const reserved of ["attempts", "supports", "resolved_by", "revises", "supersedes"]) {
      expect(SemanticEdgeKindSchema.safeParse(reserved).success).toBe(true);
      expect(ReducerDerivedEdgeKindSchema.safeParse(reserved).success).toBe(false);
    }
  });
});

describe("SessionCatalog contract", () => {
  it("accepts only bounded opaque discovery descriptors", () => {
    expect(
      SessionCatalogSchema.parse({
        catalogVersion: 1,
        command: "discover",
        source: "claude",
        matchedFiles: 1,
        selectedFiles: 1,
        sessions: [
          {
            id: "a".repeat(24),
            source: "claude",
            title: "Review checkout flow",
            projectHint: "storefront",
            firstPromptPreview: "Review checkout flow",
            lastPromptPreview: "Fix the failing test",
            lastActivityAt: "2026-08-01T00:00:00.000Z",
            byteLength: 1024,
            eventCount: 8,
            warningCount: 1,
            modifiedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        failed: [],
        skippedByLimit: 0,
        unreadableDirectories: 0,
        rejectedFiles: 0,
        missingSessionIds: [],
      }).sessions,
    ).toHaveLength(1);
  });

  it("accepts a path-free per-session import outcome", () => {
    expect(
      SessionImportOutcomeSchema.parse({
        protocolVersion: 1,
        level: "result",
        command: "import",
        sessionId: "c".repeat(24),
        traceId: ids.trace,
        inserted: 8,
        duplicates: 0,
        warnings: 1,
      }).traceId,
    ).toBe(ids.trace);
  });

  it("accepts a deterministic aggregate import summary", () => {
    expect(
      SessionImportSummarySchema.parse({
        protocolVersion: 1,
        level: "summary",
        command: "import",
        source: "codex",
        files: 2,
        imported: 1,
        failed: 1,
        inserted: 8,
        duplicates: 0,
        warnings: 1,
        matchedFiles: 4,
        skippedByLimit: 2,
        unreadableDirectories: 0,
        rejectedFiles: 0,
        missingSessionIds: [],
        firstError: "Session preflight failed; no events were imported",
      }).failed,
    ).toBe(1);
  });

  it("rejects native paths and extra descriptor fields", () => {
    expect(() =>
      SessionCatalogSchema.parse({
        catalogVersion: 1,
        command: "discover",
        source: "codex",
        matchedFiles: 1,
        selectedFiles: 1,
        sessions: [
          {
            id: "b".repeat(24),
            source: "codex",
            title: "Session",
            projectHint: null,
            firstPromptPreview: null,
            lastPromptPreview: null,
            lastActivityAt: "2026-08-01T00:00:00.000Z",
            byteLength: 1,
            eventCount: 1,
            warningCount: 0,
            modifiedAt: "2026-08-01T00:00:00.000Z",
            nativePath: "/private/session.jsonl",
          },
        ],
        failed: [],
        skippedByLimit: 0,
        unreadableDirectories: 0,
        rejectedFiles: 0,
        missingSessionIds: [],
      }),
    ).toThrow();
  });
});

describe("Session upload bundle contract", () => {
  const part = {
    clientRef: "p1",
    path: "project/session.jsonl",
    byteLength: 3,
    modifiedAt: "2026-08-01T00:00:00.000Z",
    headBase64: Buffer.from("abc").toString("base64"),
    complete: true,
  };

  it("accepts protocol v2 metadata and bounded optional heads", () => {
    expect(
      SessionUploadCandidateRequestSchema.parse({
        protocolVersion: 2,
        includePreviews: false,
        parts: [part],
      }).parts,
    ).toEqual([part]);
    expect(
      SessionUploadCandidateRequestSchema.safeParse({
        protocolVersion: 1,
        includePreviews: false,
        parts: [part],
      }).success,
    ).toBe(false);
    expect(
      SessionUploadCandidateRequestSchema.safeParse({
        protocolVersion: 2,
        includePreviews: false,
        parts: [{ ...part, headBase64: Buffer.alloc(64 * 1024 + 1).toString("base64") }],
      }).success,
    ).toBe(false);
    expect(
      SessionUploadCandidateRequestSchema.safeParse({
        protocolVersion: 2,
        includePreviews: false,
        parts: Array.from({ length: 65 }, (_, index) => ({
          ...part,
          clientRef: `p${index}`,
          path: `p${index}.jsonl`,
          headBase64: Buffer.alloc(64 * 1024).toString("base64"),
        })),
      }).success,
    ).toBe(false);
    expect(
      SessionUploadCandidateRequestSchema.safeParse({
        protocolVersion: 2,
        includePreviews: false,
        parts: Array.from({ length: 51 }, (_, index) => ({
          ...part,
          clientRef: `p${index}`,
          path: `root-${index}.jsonl`,
        })),
      }).success,
    ).toBe(false);
  });

  it("requires opaque candidate IDs and explicit part references", () => {
    const candidate = {
      clientRef: "p1",
      candidateId: "a".repeat(24),
      partRefs: ["p1"],
      source: "codex" as const,
      title: "Codex session",
      projectHint: null,
      firstPromptPreview: null,
      lastPromptPreview: null,
      partialHead: false,
      traceId: ids.trace,
      imported: false,
      importedEventCount: null,
      failureCode: null,
      failureMessage: null,
    };
    expect(
      SessionUploadCandidateListSchema.parse({
        protocolVersion: 2,
        candidates: [candidate],
        alreadyImportedCount: 0,
      }).candidates[0]?.candidateId,
    ).toBe("a".repeat(24));
    expect(
      SessionUploadCandidateListSchema.safeParse({
        protocolVersion: 2,
        candidates: [{ ...candidate, candidateId: "native-session-id" }],
        alreadyImportedCount: 0,
      }).success,
    ).toBe(false);
  });

  it("accepts protocol v2 batch upload outcomes", () => {
    expect(
      SessionImportBatchOutcomeSchema.parse({
        protocolVersion: 2,
        level: "result",
        command: "upload",
        results: [
          {
            candidateId: "b".repeat(24),
            sessionId: "c".repeat(24),
            traceId: ids.trace,
            inserted: 2,
            duplicates: 0,
            warnings: 1,
          },
        ],
      }).results,
    ).toHaveLength(1);
  });
});

describe("IntentGraphPatch contract", () => {
  it("rejects no-op updates", () => {
    const result = ProviderIntentGraphPatchSchema.safeParse({
      schemaVersion: SchemaVersion,
      jobNonce: ids.event,
      baseRevisionId: ids.trace,
      operations: [
        {
          op: "update_node",
          ref: ids.project,
          set: {},
          evidenceEventIds: [ids.event],
        },
      ],
      diagnostics: [],
    });
    expect(result.success).toBe(false);
  });

  it("limits provider patches to node semantics and merge advice", () => {
    const base = {
      schemaVersion: SchemaVersion,
      jobNonce: ids.event,
      baseRevisionId: ids.trace,
      diagnostics: [],
    };
    expect(
      ProviderIntentGraphPatchSchema.safeParse({
        ...base,
        operations: [
          {
            op: "add_node",
            ref: "tmp:1",
            node: {
              kind: "work",
              title: "Bounded node semantics",
              claims: [
                {
                  kind: "action",
                  text: "Observed work",
                  provenance: "stated",
                  suggestedConfidence: "high",
                  evidenceEventIds: [ids.event],
                },
              ],
            },
          },
        ],
      }).success,
    ).toBe(true);
    for (const op of ["add_edge", "retire_edge", "supersede_node"]) {
      expect(
        ProviderIntentGraphPatchSchema.safeParse({
          ...base,
          operations: [{ op }],
        }).success,
      ).toBe(false);
    }
  });
});

describe("SemanticRevision contract", () => {
  it("supports the empty-trace revision watermark", () => {
    expect(
      SemanticRevisionSchema.parse({
        id: ids.event,
        traceId: ids.trace,
        parentRevisionId: null,
        branchKind: "live",
        eventWatermark: "0",
        createdAt: "2026-08-01T00:00:00.000Z",
        sourceJobId: null,
      }).eventWatermark,
    ).toBe("0");
  });
});
