import { loadRuntimeConfig } from "@intenttrace/config";
import { IntentTraceRepository } from "@intenttrace/db";
import {
  DeepSeekJsonSummaryProvider,
  FoundationMockSummaryProvider,
  OpenAIResponsesSummaryProvider,
  type SummaryProvider,
} from "@intenttrace/summarizer";
import postgres from "postgres";

import {
  SHUTDOWN_FORCE_EXIT_DELAY_MS,
  SHUTDOWN_POOL_TIMEOUT_SECONDS,
  SUMMARY_POLL_INTERVAL_MS,
  SUMMARY_STATEMENT_TIMEOUT_MS,
  summaryJobBudgetMs,
} from "./policy.js";
import { createSummaryRunner, type SummaryRunnerDeps } from "./runner.js";

const config = loadRuntimeConfig();
const sql = postgres(config.DATABASE_URL, {
  max: 4,
  // Sent in the startup packet: PostgreSQL itself aborts any statement that
  // outlives this, so a lock wait cannot pin the poll loop's in-flight guard.
  connection: { statement_timeout: SUMMARY_STATEMENT_TIMEOUT_MS },
});
const repository = new IntentTraceRepository(sql);
function createProvider(): SummaryProvider {
  if (config.PROVIDER_MODE === "openai") {
    return new OpenAIResponsesSummaryProvider({
      apiKey: config.OPENAI_API_KEY!,
      model: config.OPENAI_MODEL!,
      baseUrl: config.OPENAI_BASE_URL,
      timeoutMs: config.PROVIDER_TIMEOUT_MS,
      maxEvents: config.PROVIDER_MAX_EVENTS,
    });
  }
  if (config.PROVIDER_MODE === "deepseek") {
    return new DeepSeekJsonSummaryProvider({
      apiKey: config.DEEPSEEK_API_KEY!,
      model: config.DEEPSEEK_MODEL!,
      baseUrl: config.DEEPSEEK_BASE_URL,
      timeoutMs: config.PROVIDER_TIMEOUT_MS,
      maxEvents: config.PROVIDER_MAX_EVENTS,
    });
  }
  return new FoundationMockSummaryProvider();
}
const provider = createProvider();
const providerModel =
  config.PROVIDER_MODE === "openai"
    ? config.OPENAI_MODEL!
    : config.PROVIDER_MODE === "deepseek"
      ? config.DEEPSEEK_MODEL!
      : provider.id;
let shuttingDown = false;
let pollTimer: NodeJS.Timeout | undefined;
let inFlight: Promise<unknown> | null = null;

const runnerDeps: SummaryRunnerDeps = {
  repository,
  provider,
  providerModel,
  dailyBudgetUsd: config.PROVIDER_DAILY_BUDGET_USD,
  providerMode: config.PROVIDER_MODE,
  // Shutdown drains the job already running, not the rest of the backlog.
  shouldContinue: () => !shuttingDown,
};

const runner = createSummaryRunner(runnerDeps);
// One job's worth of legitimate work; see `summaryJobBudgetMs`.
const jobBudgetMs = summaryJobBudgetMs(config.PROVIDER_TIMEOUT_MS);

async function runPass(): Promise<void> {
  const pass = runner.runDueJobs();
  inFlight = pass;
  // Report-only, deliberately not a watchdog: it never clears `inFlight` and
  // never abandons the pass. A peer that accepts the connection and then stops
  // answering is invisible to `statement_timeout` and is only broken by TCP
  // keepalive, ten minutes or more later; without this line the worker would
  // spend that whole window silent and indistinguishable from an idle one.
  const stallReport = setTimeout(() => {
    process.stderr.write(
      `IntentTrace worker pass has been running for ${jobBudgetMs}ms without finishing.\n`,
    );
  }, jobBudgetMs);
  try {
    await pass;
  } finally {
    clearTimeout(stallReport);
    if (inFlight === pass) inFlight = null;
  }
}

function tick(): void {
  // A slow pass must not stack ticks on top of itself.
  if (shuttingDown || inFlight) return;
  void runPass().catch((error: unknown) => {
    process.stderr.write(`IntentTrace worker pass failed: ${String(error)}\n`);
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(pollTimer);
  process.stdout.write(`IntentTrace worker received ${signal}; finishing current job.\n`);
  const pass = inFlight;
  if (pass) {
    let drainTimer: NodeJS.Timeout | undefined;
    // `shouldContinue` stops the pass at the next job boundary, so this only
    // waits out the job already running. It can cut healthy work: a job
    // mid-provider-call in openai/deepseek mode may be abandoned, costing one
    // already-billed call that retry re-issues, and leaving the row `running`
    // until the five-minute lease re-selects it. Nothing is corrupted.
    await Promise.race([
      pass.catch(() => undefined),
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, jobBudgetMs);
      }),
    ]);
    clearTimeout(drainTimer);
  }
  await sql.end({ timeout: SHUTDOWN_POOL_TIMEOUT_SECONDS });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => {
      process.exitCode = 0;
      // A healthy shutdown drains the loop on its own, with stdio flushed.
      // `sql.end()` only half-closes its sockets, so a peer that has stopped
      // answering never sends the matching FIN and leaves an active handle
      // behind; this unref'd timer is the only thing that then ends the
      // process, and it fires late enough for the pending writes to land.
      setTimeout(() => process.exit(0), SHUTDOWN_FORCE_EXIT_DELAY_MS).unref();
    });
  });
}

try {
  // Awaited, as the removed `dispatch()` was: an unreachable database at boot
  // must still exit non-zero instead of leaving a worker that logs forever.
  await runPass();
  // A signal that arrives during the boot pass runs `shutdown()` while
  // `pollTimer` is still `undefined`, so its `clearInterval` is a no-op.
  // Without this guard the continuation would install a ref'd interval nothing
  // ever clears — blocking natural event-loop drain — and print the polling
  // banner after the shutdown line. `tick()` already short-circuits on
  // `shuttingDown`, so no job could have started either way.
  if (!shuttingDown) {
    pollTimer = setInterval(tick, SUMMARY_POLL_INTERVAL_MS);
    process.stdout.write(
      `IntentTrace worker is polling summary_jobs every ${SUMMARY_POLL_INTERVAL_MS}ms with PostgreSQL idempotency and ${provider.id}.\n`,
    );
  }
} catch (error) {
  process.stderr.write(`IntentTrace worker failed to start: ${String(error)}\n`);
  await shutdown("startup-failure");
  process.exitCode = 1;
  setTimeout(() => process.exit(1), SHUTDOWN_FORCE_EXIT_DELAY_MS).unref();
}
