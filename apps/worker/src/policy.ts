/** Poll interval for the PostgreSQL summary job table, in milliseconds. */
export const SUMMARY_POLL_INTERVAL_MS = 2000;

/**
 * Server-side `statement_timeout` for the worker's connection pool, in
 * milliseconds. Every statement the worker issues — including a lock wait on
 * `summary_jobs` behind a stuck transaction — is aborted by PostgreSQL at this
 * bound, so a pass wedged *on the server* rejects and is logged instead of
 * pinning the poll loop's in-flight guard forever. That is the only failure
 * mode it covers: the bound is enforced by the PostgreSQL backend and only
 * reaches the client over a live connection, so a peer that accepts the
 * connection and then stops answering is invisible to it and pins `inFlight`
 * for the whole TCP keepalive window. See the `stallReport` comment in
 * `apps/worker/src/main.ts`, which is the report-only diagnostic for exactly
 * that case. Two orders of magnitude above a realistic `commitSummaryJob`
 * write, and far below the five-minute `running` lease, so a statement that
 * trips it is retried through `next_attempt_at` rather than recovered as a
 * stale claim.
 */
export const SUMMARY_STATEMENT_TIMEOUT_MS = 30000;

/** The `running` lease in `listRunnableSummaryJobIds`, in milliseconds. */
export const SUMMARY_RUNNING_LEASE_MS = 5 * 60 * 1000;

/**
 * The longest a single summary job may legitimately take: its provider call,
 * bounded by `PROVIDER_TIMEOUT_MS`, plus one statement's worth of slack for the
 * claim and commit round trips that surround it, each of which PostgreSQL
 * already holds to `SUMMARY_STATEMENT_TIMEOUT_MS`.
 *
 * Used as the shutdown drain deadline and as the threshold for reporting a pass
 * that has not finished. As a drain deadline it **can** cut healthy work:
 * `shouldContinue` is consulted only between jobs, so shutdown waits out the
 * job already running, and in `openai`/`deepseek` mode a job that is
 * mid-provider-call when the signal arrives may be abandoned. The cost is one
 * provider call that was already made and billed and will be re-issued on
 * retry, plus a row left at `status='running'` until the five-minute lease
 * re-selects it. Nothing is corrupted; the commit transaction rolls back.
 *
 * At the maximum configurable provider timeout this is 120000 + 30000 =
 * 150000 ms, half the lease, so an abandoned job is always recovered by the
 * lease rather than colliding with it.
 */
export function summaryJobBudgetMs(providerTimeoutMs: number): number {
  return providerTimeoutMs + SUMMARY_STATEMENT_TIMEOUT_MS;
}

/** Grace period, in seconds, for `sql.end()` before sockets are destroyed. */
export const SHUTDOWN_POOL_TIMEOUT_SECONDS = 5;

/**
 * How long the process waits for the event loop to drain after a graceful
 * shutdown before forcing exit, in milliseconds. `sql.end()` half-closes its
 * sockets; a peer that has stopped answering never sends the matching FIN, so
 * the handle stays active forever. Long enough for pending pipe writes to
 * flush.
 *
 * A signal can take the whole of `summaryJobBudgetMs` plus
 * `SHUTDOWN_POOL_TIMEOUT_SECONDS` plus this delay to reach process exit.
 * Whether that completes before SIGKILL is the orchestrator's stop grace
 * period to decide, and this package does not set it: if the grace period is
 * shorter, the drain is cut and neither the abandoned-pass diagnostic nor
 * `sql.end()` runs. Nothing is corrupted — the killed job leaves the same
 * `running` row the five-minute lease recovers.
 */
export const SHUTDOWN_FORCE_EXIT_DELAY_MS = 1000;

export const WorkerFoundationPolicy = Object.freeze({
  consumesJobs: true,
  providerCallsAllowed: false,
  note: "PostgreSQL summary_jobs is the only dispatch source; claims, retries and commits are authoritative.",
});
