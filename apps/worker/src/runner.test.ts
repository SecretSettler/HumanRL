import { createHash } from "node:crypto";

import type { SummaryCommitInput, SummaryJobContext } from "@intenttrace/db";
import type { ReducerRawFact } from "@intenttrace/intent-reducer";
import {
  FoundationMockSummaryProvider,
  ProviderUnavailableError,
  type ChunkSummaryInput,
  type SummaryProvider,
} from "@intenttrace/summarizer";
import { describe, expect, it, vi } from "vitest";

import { createSummaryRunner, runSummaryJob, type SummaryRunnerDeps } from "./runner.js";

const JOB_NONCE = "6f1e6f3c-0d59-4a2c-9f0a-2a0f7f2f1b11";
const OTHER_NONCE = "0a7c1f2e-4b93-4f0d-8a11-6d3b8c9e5f22";
const BASE_REVISION = "b2c4d6e8-1a3b-4c5d-8e9f-0a1b2c3d4e5f";

const chunkInput: ChunkSummaryInput = {
  jobNonce: JOB_NONCE,
  baseRevisionId: BASE_REVISION,
  eventSketch: [],
  allowedEventIds: [],
  allowedArtifactIds: [],
  allowedAgentIds: [],
  allowedNodeIds: [],
  locale: "zh-CN",
};

// A real, schema-valid empty patch. Building it through the shipped mock
// provider keeps the fakes honestly typed without importing the schema package
// into the worker just for `SchemaVersion`.
const acceptedPatch = await new FoundationMockSummaryProvider().summarizeChunk(chunkInput);
// Same patch, wrong nonce: the reducer refuses it with `nonce_mismatch`.
const rejectedPatch = { ...acceptedPatch, jobNonce: OTHER_NONCE };

function context(overrides: Partial<SummaryJobContext> = {}): SummaryJobContext {
  return {
    id: "job-1",
    traceId: "1d0f4c0a-7a3e-4a2f-8f1b-9c2d3e4f5a60",
    chunkId: "2e1a5d1b-8b4f-4b30-90ac-ad3e4f5a6b71",
    baseRevisionId: BASE_REVISION,
    jobNonce: JOB_NONCE,
    inputHash: "input-hash",
    eventWatermark: "1",
    branchKind: "live",
    promptVersion: "prompt-v1",
    policyVersion: "policy-v1",
    allowedEventIds: [],
    allowedArtifactIds: [],
    allowedAgentIds: [],
    eventSketch: [],
    reducerFacts: [],
    registeredArtifactIds: [],
    graph: { nodes: [], edges: [] },
    ...overrides,
  };
}

interface DepsOverrides {
  repository?: Partial<SummaryRunnerDeps["repository"]>;
  provider?: Partial<SummaryProvider>;
  providerModel?: string;
  dailyBudgetUsd?: number;
  providerMode?: SummaryRunnerDeps["providerMode"];
  shouldContinue?: () => boolean;
}

function deps(overrides: DepsOverrides = {}): SummaryRunnerDeps {
  return {
    repository: {
      listRunnableSummaryJobIds: async () => [],
      claimSummaryJob: async () => context(),
      getProviderSpendToday: async () => 0,
      failSummaryJob: async () => undefined,
      commitSummaryJob: async () => "rev-2",
      ...overrides.repository,
    },
    provider: {
      id: "mock",
      egress: "local",
      extractUserIntent: async () => acceptedPatch,
      summarizeChunk: async () => acceptedPatch,
      reconcileGraph: async () => acceptedPatch,
      ...overrides.provider,
    },
    providerModel: overrides.providerModel ?? "mock",
    dailyBudgetUsd: overrides.dailyBudgetUsd ?? 0,
    providerMode: overrides.providerMode ?? "mock",
    ...(overrides.shouldContinue ? { shouldContinue: overrides.shouldContinue } : {}),
  };
}

describe("runSummaryJob", () => {
  it("skips a job it cannot claim", async () => {
    const claimSummaryJob = vi.fn(async () => null);
    const result = await runSummaryJob(deps({ repository: { claimSummaryJob } }), "job-1");
    expect(result).toEqual({ status: "skipped" });
    expect(claimSummaryJob).toHaveBeenCalledWith("job-1");
  });

  it("cancels without retry when the reducer rejects the patch", async () => {
    const failSummaryJob = vi.fn(async () => undefined);
    const result = await runSummaryJob(
      deps({
        repository: { failSummaryJob },
        provider: { summarizeChunk: async () => rejectedPatch },
      }),
      "job-1",
    );
    expect(result.status).toBe("rejected");
    // retry=false: a patch the reducer refuses will be refused again.
    expect(failSummaryJob).toHaveBeenCalledWith("job-1", "nonce_mismatch", false);
  });

  it("marks a provider outage retryable and reports raw_only", async () => {
    const failSummaryJob = vi.fn(async () => undefined);
    const result = await runSummaryJob(
      deps({
        repository: { failSummaryJob },
        provider: {
          summarizeChunk: async () => {
            throw new ProviderUnavailableError("timeout");
          },
        },
      }),
      "job-1",
    );
    expect(result).toEqual({ status: "raw_only", reason: "timeout" });
    expect(failSummaryJob).toHaveBeenCalledWith("job-1", "timeout", false);
  });

  it("refuses to call a cloud provider once the daily budget is reached", async () => {
    const summarizeChunk = vi.fn(async () => acceptedPatch);
    const result = await runSummaryJob(
      deps({
        repository: { getProviderSpendToday: async () => 5 },
        provider: { egress: "cloud", summarizeChunk },
        dailyBudgetUsd: 5,
      }),
      "job-1",
    );
    expect(result).toEqual({ status: "raw_only", reason: "budget" });
    expect(summarizeChunk).not.toHaveBeenCalled();
  });

  it("commits the reduced state with the provider fingerprint and content hashes", async () => {
    const commits: { jobId: string; input: SummaryCommitInput }[] = [];
    const commitSummaryJob = vi.fn(async (jobId: string, input: SummaryCommitInput) => {
      commits.push({ jobId, input });
      return "rev-2";
    });
    const result = await runSummaryJob(deps({ repository: { commitSummaryJob } }), "job-1");
    expect(result).toEqual({ status: "committed", revisionId: "rev-2" });
    expect(commits).toHaveLength(1);
    const { jobId, input } = commits[0]!;
    expect(jobId).toBe("job-1");
    expect(input).toMatchObject({
      provider: "mock",
      model: "mock",
      egress: "local",
      state: { nodes: [], edges: [] },
      changedNodeIds: [],
      changedEdgeIds: [],
    });
    // Derived, not pasted: the digests must be *these* two values in *this*
    // order, so swapping the two hash arguments in runner.ts fails here.
    const { inputHash, eventSketch } = context();
    expect(input.requestHash).toBe(
      createHash("sha256")
        .update(JSON.stringify({ inputHash, sketch: eventSketch }))
        .digest("hex"),
    );
    expect(input.responseHash).toBe(
      createHash("sha256").update(JSON.stringify(acceptedPatch)).digest("hex"),
    );
    // A provider that reports no usage must not invent a price or a token count.
    expect(input).not.toHaveProperty("inputTokens");
    expect(input).not.toHaveProperty("outputTokens");
    expect(input).not.toHaveProperty("costUsd");
  });

  it("derives topology from repository facts outside the provider input", async () => {
    const parentEvent = "019fbbb3-4324-7d43-8f9c-cd489a92cf01";
    const childEvent = "019fbbb3-4324-7d43-8f9c-cd489a92cf02";
    const parentNode = "019fbbb3-4324-7d43-8f9c-cd489a92ca01";
    const childNode = "019fbbb3-4324-7d43-8f9c-cd489a92ca02";
    const facts: ReducerRawFact[] = [
      {
        eventId: parentEvent,
        sourceKind: "jsonl",
        adapterVersion: "1.0.0",
        sourceEventId: "dispatch",
        ingestSeq: "1",
        kind: "agent_handoff",
        status: "ok",
        agentId: "root",
        spanId: "call-1",
        parentSpanId: null,
        causationEventId: null,
        artifactRefs: [],
        spawnedAgentIds: ["child"],
      },
      {
        eventId: childEvent,
        sourceKind: "jsonl",
        adapterVersion: "1.0.0",
        sourceEventId: "child-start",
        ingestSeq: "2",
        kind: "agent_start",
        status: "ok",
        agentId: "child",
        spanId: null,
        parentSpanId: "call-1",
        causationEventId: null,
        artifactRefs: [],
        parentAgentId: "root",
      },
    ];
    const graph = {
      nodes: [
        {
          logicalNodeId: parentNode,
          versionId: "019fbbb3-4324-7d43-8f9c-cd489a92cb01",
          kind: "work" as const,
          status: "active" as const,
          title: "Dispatch",
          claims: [
            {
              kind: "action" as const,
              text: "Dispatch",
              provenance: "stated" as const,
              confidence: "high" as const,
              evidenceEventIds: [parentEvent],
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
        {
          logicalNodeId: childNode,
          versionId: "019fbbb3-4324-7d43-8f9c-cd489a92cb02",
          kind: "work" as const,
          status: "active" as const,
          title: "Child",
          claims: [
            {
              kind: "action" as const,
              text: "Child",
              provenance: "stated" as const,
              confidence: "high" as const,
              evidenceEventIds: [childEvent],
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
    const commits: SummaryCommitInput[] = [];
    const providerInput = vi.fn(async () => acceptedPatch);
    const result = await runSummaryJob(
      deps({
        repository: {
          claimSummaryJob: async () => context({ eventWatermark: "2", reducerFacts: facts, graph }),
          commitSummaryJob: async (_jobId, input) => {
            commits.push(input);
            return "rev-topology";
          },
        },
        provider: { summarizeChunk: providerInput },
      }),
      "job-1",
    );
    expect(result).toEqual({ status: "committed", revisionId: "rev-topology" });
    expect(providerInput).toHaveBeenCalledWith(
      expect.not.objectContaining({ reducerFacts: expect.anything() }),
    );
    expect(commits[0]?.state.edges).toMatchObject([
      {
        sourceNodeId: parentNode,
        targetNodeId: childNode,
        kind: "decomposes_to",
        evidenceEventIds: [parentEvent, childEvent].sort(),
        provenance: "stated",
      },
    ]);
  });

  it("prices a metered provider call from the usage it reports", async () => {
    const commits: SummaryCommitInput[] = [];
    const commitSummaryJob = vi.fn(async (jobId: string, input: SummaryCommitInput) => {
      commits.push(input);
      return `rev-for-${jobId}`;
    });
    const result = await runSummaryJob(
      deps({
        repository: { commitSummaryJob, getProviderSpendToday: async () => 0 },
        provider: {
          id: "deepseek-json-v1",
          egress: "cloud",
          takeUsage: () => ({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
        },
        providerMode: "deepseek",
        providerModel: "deepseek-v4-flash",
        dailyBudgetUsd: 10,
      }),
      "job-1",
    );
    expect(result).toEqual({ status: "committed", revisionId: "rev-for-job-1" });
    // deepseek-v4-flash: 0.14 + 0.28 USD per million in/out tokens.
    expect(commits[0]).toMatchObject({
      provider: "deepseek-json-v1",
      model: "deepseek-v4-flash",
      egress: "cloud",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costUsd: 0.42,
    });
  });
});

describe("createSummaryRunner", () => {
  it("runs every due job in one pass and reports how many it processed", async () => {
    const claimed: string[] = [];
    const runner = createSummaryRunner(
      deps({
        repository: {
          listRunnableSummaryJobIds: async () => ["a", "b", "c"],
          claimSummaryJob: async (id: string) => {
            claimed.push(id);
            return context({ id });
          },
        },
      }),
    );
    await expect(runner.runDueJobs()).resolves.toBe(3);
    expect(claimed).toEqual(["a", "b", "c"]);
  });

  it("does not let one failing job stop the rest of the pass", async () => {
    const claimed: string[] = [];
    const runner = createSummaryRunner(
      deps({
        repository: {
          listRunnableSummaryJobIds: async () => ["a", "b"],
          claimSummaryJob: async (id: string) => {
            claimed.push(id);
            if (id === "a") throw new Error("boom");
            return context({ id });
          },
        },
      }),
    );
    await expect(runner.runDueJobs()).resolves.toBe(2);
    expect(claimed).toEqual(["a", "b"]);
  });

  it("stops at the next job boundary once shouldContinue turns false", async () => {
    const claimed: string[] = [];
    let running = true;
    const runner = createSummaryRunner(
      deps({
        shouldContinue: () => running,
        repository: {
          listRunnableSummaryJobIds: async () => ["a", "b", "c"],
          claimSummaryJob: async (id: string) => {
            claimed.push(id);
            // Shutdown lands while "a" is in flight; "b" and "c" must not start.
            running = false;
            return context({ id });
          },
        },
      }),
    );
    await expect(runner.runDueJobs()).resolves.toBe(1);
    expect(claimed).toEqual(["a"]);
  });

  it("starts no job at all when shouldContinue is already false", async () => {
    const claimed: string[] = [];
    const runner = createSummaryRunner(
      deps({
        shouldContinue: () => false,
        repository: {
          listRunnableSummaryJobIds: async () => ["a", "b"],
          claimSummaryJob: async (id: string) => {
            claimed.push(id);
            return context({ id });
          },
        },
      }),
    );
    await expect(runner.runDueJobs()).resolves.toBe(0);
    expect(claimed).toEqual([]);
  });
});
