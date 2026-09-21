import { createHash } from "node:crypto";

import { lookupTopologyCapability } from "@intenttrace/adapters";
import type { IntentTraceRepository } from "@intenttrace/db";
import { StaleSummaryJobError } from "@intenttrace/db";
import { applyProviderPatch, topologyCapabilityKey } from "@intenttrace/intent-reducer";
import {
  ProviderUnavailableError,
  calculateProviderCost,
  type SummaryProvider,
} from "@intenttrace/summarizer";

export type SummaryJobOutcome =
  | { status: "skipped" }
  | { status: "rejected"; issues: readonly { code: string }[] }
  | { status: "raw_only"; reason: string }
  | { status: "committed"; revisionId: string };

export interface SummaryRunnerDeps {
  repository: Pick<
    IntentTraceRepository,
    | "listRunnableSummaryJobIds"
    | "claimSummaryJob"
    | "getProviderSpendToday"
    | "failSummaryJob"
    | "commitSummaryJob"
  >;
  provider: SummaryProvider;
  providerModel: string;
  dailyBudgetUsd: number;
  /** Cost mode passed through to `calculateProviderCost`. */
  providerMode: "mock" | "openai" | "deepseek";
  /**
   * Cooperative stop, consulted at every job boundary. Returning `false` ends
   * the pass without starting another job, so shutdown drains one job rather
   * than the whole backlog. Omitted means "always continue".
   */
  shouldContinue?: () => boolean;
}

export interface SummaryRunner {
  /**
   * Processes every currently due job serially, stopping early once
   * `deps.shouldContinue` returns `false`. Returns how many were attempted.
   */
  runDueJobs(): Promise<number>;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function runSummaryJob(
  deps: SummaryRunnerDeps,
  summaryJobId: string,
): Promise<SummaryJobOutcome> {
  const context = await deps.repository.claimSummaryJob(summaryJobId);
  if (!context) return { status: "skipped" };
  try {
    if (
      deps.provider.egress === "cloud" &&
      (await deps.repository.getProviderSpendToday()) >= deps.dailyBudgetUsd
    ) {
      throw new ProviderUnavailableError("budget");
    }
    const patch = await deps.provider.summarizeChunk({
      jobNonce: context.jobNonce,
      baseRevisionId: context.baseRevisionId,
      eventSketch: context.eventSketch,
      allowedEventIds: context.allowedEventIds,
      allowedArtifactIds: context.allowedArtifactIds,
      allowedAgentIds: context.allowedAgentIds,
      allowedNodeIds: context.graph.nodes.map((node) => node.logicalNodeId),
      locale: "zh-CN",
    });
    const capabilities = new Map<string, ReturnType<typeof lookupTopologyCapability>>();
    for (const fact of context.reducerFacts) {
      const key = topologyCapabilityKey(fact.sourceKind, fact.adapterVersion);
      if (capabilities.has(key)) continue;
      capabilities.set(key, lookupTopologyCapability(fact.sourceKind, fact.adapterVersion));
    }
    const reduced = applyProviderPatch(
      patch,
      context.graph,
      {
        expectedBaseRevisionId: context.baseRevisionId,
        expectedJobNonce: context.jobNonce,
        allowedEventIds: new Set(context.allowedEventIds),
        allowedArtifactIds: new Set(context.allowedArtifactIds),
        allowedAgentIds: new Set(context.allowedAgentIds),
        allowedNodeIds: new Set(context.graph.nodes.map((node) => node.logicalNodeId)),
        allowedEdgeIds: new Set(context.graph.edges.map((edge) => edge.logicalEdgeId)),
        pinnedNodeIds: new Set(
          context.graph.nodes
            .filter((node) => node.pinnedByHuman)
            .map((node) => node.logicalNodeId),
        ),
      },
      {
        traceId: context.traceId,
        eventWatermark: context.eventWatermark,
        facts: context.reducerFacts,
        capabilities,
        registeredArtifactIds: new Set(context.registeredArtifactIds),
      },
    );
    if (!reduced.ok) {
      await deps.repository.failSummaryJob(
        context.id,
        reduced.issues[0]?.code ?? "patch_rejected",
        false,
      );
      return { status: "rejected", issues: reduced.issues };
    }
    const usage = deps.provider.takeUsage?.() ?? null;
    const costUsd = usage
      ? calculateProviderCost(
          deps.providerMode,
          deps.providerModel,
          usage.inputTokens,
          usage.outputTokens,
        )
      : null;
    const revisionId = await deps.repository.commitSummaryJob(context.id, {
      state: reduced.state,
      changedNodeIds: reduced.changedNodeIds,
      changedEdgeIds: reduced.changedEdgeIds,
      provider: deps.provider.id,
      model: deps.providerModel,
      requestHash: hash({ inputHash: context.inputHash, sketch: context.eventSketch }),
      responseHash: hash(patch),
      diagnostics: reduced.diagnostics,
      egress: deps.provider.egress,
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
      ...(costUsd === null ? {} : { costUsd }),
    });
    return { status: "committed", revisionId };
  } catch (error) {
    if (error instanceof ProviderUnavailableError) {
      await deps.repository.failSummaryJob(context.id, error.code, false);
      return { status: "raw_only", reason: error.code };
    }
    if (!(error instanceof StaleSummaryJobError)) {
      await deps.repository.failSummaryJob(
        context.id,
        error instanceof Error ? error.name : "worker_failure",
        true,
      );
    }
    throw error;
  }
}

export function createSummaryRunner(deps: SummaryRunnerDeps): SummaryRunner {
  return {
    async runDueJobs(): Promise<number> {
      const ids = await deps.repository.listRunnableSummaryJobIds();
      let attempted = 0;
      for (const id of ids) {
        if (deps.shouldContinue?.() === false) break;
        attempted += 1;
        try {
          await runSummaryJob(deps, id);
        } catch (error) {
          // Log and skip: one bad job must not abandon the rest of the pass.
          // Job-row state depends on the path — a claim-time throw records
          // nothing, a generic error was already recorded by failSummaryJob,
          // and StaleSummaryJobError means commitSummaryJob's transaction
          // rebased the row; see IntentTraceRepository. Retry is driven by
          // next_attempt_at, never by this loop.
          process.stderr.write(`summary job ${id} failed: ${String(error)}\n`);
        }
      }
      return attempted;
    },
  };
}
