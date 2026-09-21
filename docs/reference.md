---
status: accepted
owner: maintainers
last_reviewed: 2026-08-11
normative: true
milestone: Gate 0-Gate 5
---

# Reference

The configuration key table and the glossary. The configuration table is validated key by key against `packages/config/src/index.ts` by `scripts/checks/check-docs.mjs`; a new configuration key must update this file at the same time.

## Configuration reference

| Variable                    | Default                                    | Constraint/purpose                            |
| --------------------------- | ------------------------------------------ | --------------------------------------------- |
| `NODE_ENV`                  | `development`                              | development/test/production                   |
| `LOG_LEVEL`                 | `info`                                     | Pino level; sensitive headers redacted        |
| `APP_VERSION`               | `0.0.0`                                    | `/version` build version                      |
| `GIT_COMMIT`                | `development`                              | `/version` provenance                         |
| `API_HOST`                  | `127.0.0.1`                                | host development must not change it to public |
| `API_PORT`                  | `3001`                                     | 1–65535                                       |
| `DATABASE_URL`              | `postgres://…@127.0.0.1:15432/intenttrace` | PostgreSQL URL                                |
| `ARTIFACT_ROOT`             | `.intenttrace/artifacts`                   | resolved to an absolute local path            |
| `IMPORT_UPLOAD_MAX_BYTES`   | `67108864`                                 | 64 KiB–512 MiB; browser upload cap            |
| `PROVIDER_MODE`             | `mock`                                     | `mock`, `openai`, or `deepseek`               |
| `PROVIDER_EGRESS_ENABLED`   | `false`                                    | cloud mode must set it explicitly to true     |
| `PROVIDER_DAILY_BUDGET_USD` | `0`                                        | cloud mode must make it positive              |
| `PROVIDER_TIMEOUT_MS`       | `30000`                                    | 1000–120000                                   |
| `PROVIDER_MAX_EVENTS`       | `256`                                      | egress event-sketch cap                       |
| `OPENAI_API_KEY`            | unset                                      | required only in openai mode; not logged      |
| `OPENAI_MODEL`              | unset                                      | must be explicit; example `gpt-5.6-sol`       |
| `OPENAI_BASE_URL`           | `https://api.openai.com/v1`                | host must be `api.openai.com`                 |
| `DEEPSEEK_API_KEY`          | unset                                      | required only in deepseek mode                |
| `DEEPSEEK_MODEL`            | unset                                      | example `deepseek-v4-flash`                   |
| `DEEPSEEK_BASE_URL`         | `https://api.deepseek.com`                 | host must be `api.deepseek.com`               |
| `INTENTTRACE_API_ORIGIN`    | `http://127.0.0.1:3001`                    | web server-side health proxy                  |
| `INTENTTRACE_WEB_PORT`      | empty                                      | Compose only; empty auto-assigns the port     |
| `NEXT_TELEMETRY_DISABLED`   | empty (vendor default is on)               | not a RuntimeConfig key; image and CI set `1` |
| `TURBO_TELEMETRY_DISABLED`  | empty (vendor default is on)               | not a RuntimeConfig key; image and CI set `1` |

`PROVIDER_TIMEOUT_MS` is coupled to the Compose `stop_grace_period`: the worker's shutdown budget is `summaryJobBudgetMs(PROVIDER_TIMEOUT_MS)` (that is, `PROVIDER_TIMEOUT_MS + SUMMARY_STATEMENT_TIMEOUT_MS` 30000 ms) plus `SHUTDOWN_POOL_TIMEOUT_SECONDS` (5 s) plus `SHUTDOWN_FORCE_EXIT_DELAY_MS` (1000 ms), all three defined in `apps/worker/src/policy.ts`. At the default 30000 ms the worst case is 66 s, and `stop_grace_period: 75s` in `docker-compose.yml` covers it. Raising `PROVIDER_TIMEOUT_MS` to the 120000 ms ceiling makes the worst case 156 s, and past 75 s the worker is SIGKILLed midway through draining: a running job leaves a `status='running'` row, which is reclaimed by the five-minute lease, does not corrupt data, but loses one already-billed provider call. **Raising `PROVIDER_TIMEOUT_MS` must raise `stop_grace_period` at the same time**; no script validates this relationship.

The configuration loader ignores unrelated environment variables but strictly validates known fields; `REDIS_URL` was deleted from the schema along with the queue removal, and the loader no longer accepts that key. `.env.example` may be committed; `.env` and any key are not. The host-run default URLs in the table are only for explicit local process development; by default Compose injects the `postgres:5432` and `api:3001` service addresses and does not publish those ports. Inside a Compose container the API may listen on `0.0.0.0`, but the one web host mapping must be `127.0.0.1`; the two are not the same security boundary.

The last two rows are not part of `RuntimeConfigSchema` and the loader does not read them either: Next.js and Turborepo each enable anonymous build telemetry by default, so `infra/Dockerfile`, `docker-compose.yml`, and `.github/workflows/ci.yml` set them explicitly to `1`. `pnpm build` is `turbo run build`, so a host build that does not go through Docker still gets the vendor defaults and you must export these two variables yourself; the vendors' own opt-out commands and their working-directory side effects are in [data handling](security.md#data-handling). IntentTrace's own code contains no analytics client, crash reporter, or usage ping.

## Glossary

- **ETG (Execution Trace Graph)**: immutable raw execution facts and lineage.
- **EIG (Evidence-backed Intent Graph)**: the semantic graph derived from the ETG, versionable and evidence-backed claim by claim.
- **RawTraceEvent**: the normalized, versioned fact envelope; the body is kept as a hash/ref.
- **logical ID / version ID**: identity stable across revisions / a single immutable content version.
- **revision**: a snapshot of node/edge membership at one event watermark.
- **watermark**: the largest `ingestSeq` this view has taken in; not source time.
- **event sketch**: the mechanically compressed, redacted, provider-facing minimal input.
- **patch**: the explicit graph operations a provider proposes; not committed semantics.
- **reducer**: the component that deterministically validates, canonicalizes, and transaction-commits a patch.
- **evidence**: an auditable reference from a claim to a raw event/artifact.
- **ghost state**: the deterministic UI state while a chunk is pending; contains no unverified model output.
- **ArtifactStore**: the large-object boundary of `put/stat/getRange/deleteTrace`.
- **source identity**: the session/event combination used for idempotency in an adapter source.
- **outbox**: the event record persisted in the same transaction as the business write, used for SSE/queue publication.
- **raw-only**: the degraded mode that can still browse ingested facts when the semantic pipeline is unavailable.
