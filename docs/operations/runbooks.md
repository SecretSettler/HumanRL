---
status: draft
owner: operations
last_reviewed: 2026-08-10
normative: true
milestone: Gate 2-Gate 5 and post-Gate 5 runtime slimming
---

# Runbooks

Four incident-handling manuals: provider unavailable, summary job table anomaly, datastore failure, SSE replay. Apart from the summary job queue section, the source document status of the other three sections is still `draft`.

## Runbook: Provider outage

Symptoms: provider timeout/429/5xx, bad JSON, exhausted budget, rising summary job age; raw ingest/query normal. First confirm whether egress is explicitly enabled and check the registry/model snapshot, inspect the audit that carries hash/status only, and do not print prompts/keys.

Actions: turn off the real provider or stay raw-only; pause retries of the affected jobs and use bounded backoff; do not switch to another provider; verify the API/raw UI is usable. After recovery, replay only the jobs that still match the base revision/input hash, and re-chunk the stale ones.

Exit criteria: error rate and queue age recovered, sampled patches pass the reducer, no secrets in logs. Record the affected traces, the time, the provider/model and the cost; do not call it an ingestion outage.

## Runbook: Summary job queue

_The source document status is `accepted`._

There is no external queue. Dispatch is a single table, `summary_jobs`, polled by the worker every 2 seconds (`SUMMARY_POLL_INTERVAL_MS`) and processed serially, with concurrency 1. This table is the whole troubleshooting target, see [ADR 0014](../decisions.md#adr-0014-postgresql-single-source-job-scheduling).

Symptoms: rows in `summary_jobs` stuck at `status='running'` for a long time; `attempt_count` climbing continuously; worker crash loop (the container restarts repeatedly, or `summary job … failed` keeps appearing in the log); the `created_at` age of `pending` rows growing while `committed` does not increase; the UI keeps showing raw-only.

Actions: locate by status first, do not touch the data first.

```sql
select status, count(*), min(created_at), max(attempt_count), max(last_error_code)
from summary_jobs group by status order by status;

select id, status, attempt_count, next_attempt_at, last_error_code, updated_at
from summary_jobs
where status in ('pending', 'failed', 'running')
order by updated_at limit 50;
```

`last_error_code` and `attempt_count` tell you whether the problem is the provider, the reducer or the worker itself; `next_attempt_at` tells you when this row will be re-claimed. Interpretation rules:

- `status='failed'` with `next_attempt_at` in the future — normal backoff; `failSummaryJob` sets `now() + 5s`, and once that expires `listRunnableSummaryJobIds` picks it up again automatically. A single observation requires no action. But there is **no retry limit**: `attempt_count` is only incremented by `claimSummaryJob` and no query reads it, so the same job retries forever every 5 seconds. A continuously climbing `attempt_count` means the root cause is not fixed and must be handled according to `last_error_code` instead of waiting for backoff.
- `status='running'` with `updated_at` within five minutes — the job is running, or was just claimed. The initial value of `updated_at` comes from the column's `default now()` (when the job enters the table), and afterwards it is only written on claim, commit, failure/cancellation and rebase, and is **not refreshed while running**, so it is a static and steadily ageing timestamp and cannot be used to judge progress. A normal job finishes within `summaryJobBudgetMs` (`PROVIDER_TIMEOUT_MS + 30000`, default 60 seconds), far below the five-minute lease; the worker's `statement_timeout` is 30 seconds, and when the budget is exceeded the log prints one report of the unfinished pass.
- `status='running'` with `updated_at` older than 5 minutes — a row left behind by a killed worker. The five-minute lease in that same query is the reaper: it selects the row again and `claimSummaryJob`'s conditional `UPDATE` claims it atomically. This is the only crash-recovery mechanism and needs no manual intervention.
- `status='cancelled'` with `next_attempt_at is null` — the reducer rejected the patch, or a budget/provider rejection was triggered, or `base_revision_missing` (`claimSummaryJob` found the base revision snapshot missing, which is a data-integrity signal rather than a policy rejection). **This is a cancellation, not a retry**: that trace shows raw-only, and a `summary.failed` stream event has already been emitted. It must not be manually set back to `pending` to force it through — bypassing the reducer is exactly how an unvalidated patch gets into an immutable revision. To regenerate the semantic graph, go through the normal new summary command path.

Action order: stop the misbehaving worker (`docker compose stop worker`) → fix the root cause (database reachability, provider configuration, image version) → restart the worker and let `next_attempt_at` and the five-minute lease drive re-claiming on their own. **Deleting or rewriting `summary_jobs` rows to "align" the state is forbidden**: the `(trace_id, input_hash)` unique index and `job_nonce` are the idempotency identity, and removing them makes the same input produce a second revision. Also do not manually `update` `cancelled` into `pending`.

One of those rewrites is unrecoverable and has to be named separately: **rewriting a job row that already has a corresponding `semantic_revisions.source_job_id` back into any claimable state is forbidden** (`pending`, or directly to `running` with `updated_at` rolled back). Such a row can never leave `running` again: `commitSummaryJob` at `packages/db/src/repository.ts:952-955` first queries `semantic_revisions where source_job_id = jobId` and, on a hit, returns the existing revision id directly, skipping the `status='committed'` write at `:1044-1047`; so the row stays at `running` forever, the five-minute lease re-claims it back into that same early return every cycle, and `claimSummaryJob` adds one to `attempt_count` each time with no retry limit at all. In `openai`/`deepseek` mode, every cycle also burns one billed provider call. There is no self-healing path; the row can only be set back to `committed` by hand. To regenerate the semantic graph, go through the normal new summary command path.

Recovery evidence: the maximum age of `pending` rows falls back; each committed job corresponds to exactly one revision (`select count(*) from summary_jobs where status='committed'` equals `select count(*) from semantic_revisions where source_job_id is not null` — the initial live revision created with the trace and human edit revisions both have no `source_job_id` and are not counted); no `running` row has `updated_at` older than five minutes; the raw event page stays available throughout the whole process — raw facts already stored in PostgreSQL do not depend on the worker. Record the failure code, `attempt_count` and the input hash, not sensitive bodies.

## Runbook: Datastore failure

When PostgreSQL readiness fails, the API returns degraded/503 and stops accepting writes; raw events must not be cached in unreliable memory and then reported as successful. PostgreSQL is at the same time the only source of job dispatch, so while it is unavailable summary jobs merely stop being claimed and resume on their own after recovery according to `next_attempt_at` and the five-minute `running` lease; when ArtifactStore fails, the metadata/payload transaction must not leave an illusion of success.

Check the disk, volumes, container health, connection count and migrations, and do not run unreviewed repair SQL. If data is corrupted, stop the services, copy the faulty volume, and restore onto a new volume following backup-restore; do not overwrite the last recoverable copy.

After recovery, run the migration no-op, hash/count/revision integrity, health and the target trace query. State which evidence is an automated check and which is manual environment verification.

## Runbook: SSE recovery

After a disconnect the client reconnects carrying the last applied outbox ID; the service replays from the next ID. The client must deduplicate monotonically and stop applying temporary state on a gap, and must not guess a lost semantic commit.

If the cursor is still within retention, verify that the replay is continuous and returns to live; if it has expired, the service returns `410 cursor_expired` and the client fetches a snapshot/cursor again. Server heartbeats do not generate business IDs; unvalidated provider output must not enter the replay stream.

The failure drill should cover network disconnection, service restart, duplicate frames, gaps, an expired cursor, and trace A's cursor used for trace B. Record the final revision/watermark and snapshot consistency.
