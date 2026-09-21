import { describe, expect, it } from "vitest";

import {
  SUMMARY_POLL_INTERVAL_MS,
  SUMMARY_RUNNING_LEASE_MS,
  SUMMARY_STATEMENT_TIMEOUT_MS,
  WorkerFoundationPolicy,
  summaryJobBudgetMs,
} from "./policy.js";

/** The bounds `PROVIDER_TIMEOUT_MS` is validated against in `@intenttrace/config`. */
const PROVIDER_TIMEOUT_MIN_MS = 1000;
const PROVIDER_TIMEOUT_MAX_MS = 120000;

describe("worker local MVP policy", () => {
  it("consumes jobs while cloud provider calls remain disabled by default", () => {
    expect(SUMMARY_POLL_INTERVAL_MS).toBe(2000);
    expect(WorkerFoundationPolicy).toMatchObject({
      consumesJobs: true,
      providerCallsAllowed: false,
    });
  });

  it("keeps a job's budget above its provider call and below the running lease", () => {
    // The budget must outlast the provider call it wraps, or shutdown would cut
    // every cloud job it ever drains.
    expect(summaryJobBudgetMs(PROVIDER_TIMEOUT_MAX_MS)).toBeGreaterThan(PROVIDER_TIMEOUT_MAX_MS);
    // And it must stay under the lease even at the largest configurable
    // provider timeout, so a job abandoned at the drain deadline is recovered
    // by the lease instead of colliding with it.
    expect(summaryJobBudgetMs(PROVIDER_TIMEOUT_MAX_MS)).toBeLessThan(SUMMARY_RUNNING_LEASE_MS);
    // At the smallest configurable provider timeout it must still outlast an
    // ordinary poll pass, or healthy work would be cut by its own safety net.
    expect(summaryJobBudgetMs(PROVIDER_TIMEOUT_MIN_MS)).toBeGreaterThan(SUMMARY_POLL_INTERVAL_MS);
  });

  it("aborts a wedged statement well before the running lease claims its row", () => {
    // A statement that trips its timeout must fail and be retried through
    // next_attempt_at, never linger long enough to be recovered as a stale claim.
    expect(SUMMARY_STATEMENT_TIMEOUT_MS).toBeLessThan(SUMMARY_RUNNING_LEASE_MS);
    expect(SUMMARY_STATEMENT_TIMEOUT_MS).toBeGreaterThan(SUMMARY_POLL_INTERVAL_MS);
  });
});
