---
status: current
owner: maintainers
last_reviewed: 2026-08-10
normative: true
milestone: Gate 0-Gate 5
---

# Testing

This document covers the layered test strategy, the acceptance fixture and the mandatory acceptance matrix, reducer property tests, the semantic evaluation method, and the performance methodology. The non-claims of each section do not substitute for one another: a mock, a synthetic fixture, a static check, and real-environment evidence each prove only their own layer.

## Test strategy

Unit tests cover pure functions/config/path/storage; contract tests cover Zod, adapters, ingest, the reducer, the DB schema, and generated-artifact drift; integration tests use a real PostgreSQL/ArtifactStore to verify transactions and crash redelivery; E2E verifies only implemented UI/API; property tests explore operation sequences; performance follows its own separate methodology.

The current suite covers the four adapters/unknown version, Collector checkpoint, payload choreography, OTLP gzip, reducer confidence/cycle/pin/determinism, provider redaction/JSON validation, the browser baseline for Graph/Gantt/Evidence/replay, restore, and the synthetic scale smoke. The Docker environment additionally runs the 2,048-event ingestion/semantic commit, migration×2, and backup restore; the outage drill has been executed on the two-image stack in worker-only form (2026-08-10: only `docker compose stop worker`; all 2,048 raw events returned HTTP 200 across 3 pages, `/readyz` returned 200 `{postgres:"ok"}` — PostgreSQL is the only probed dependency and the worker is not a readiness dimension; backlogged jobs resumed processing after the restart), while the three-image stack drill from before Redis was removed stopped Redis and the worker at the same time and readiness was 503.

Every test result must record the environment and the command. A static schema check is not a migration execution, a mock provider is not a cloud call, and a synthetic fixture is not real-world accuracy.

## Acceptance fixture

The fixed-seed fixture has at least 2,000 raw events and 6 agents: 1 orchestrator + the five specialists research/backend/frontend/summarization/testing. The story must contain a user goal, parallel decomposition, handoff, join, one failure caused by a malformed ID, an observable repair, a test rerun, and a final result.

Every event has a stable source identity, source/source-ingest time, lineage, and a payload hash/ref; it includes duplicates, out-of-order events, late events, missing optional fields, and rotation boundaries. The golden manifest records the generator version, seed, event count, agent count, and file hashes; no real session or secret is committed.

`generateAcceptanceFixture(2048)` implements the separate fixed-seed six-agent synthetic acceptance story, and `pnpm demo:load:synthetic` imports it through the actual web→API path. `pnpm demo:load` imports the committed real recording `packages/test-fixtures/fixtures/demo/imo-2025-p1-parallel-solve.jsonl` (691 events, 9 lanes, 8 child starts, 8 spawns, and 8 joins). The recorder requires the verified root transcript plus exactly eight named child JSONLs, rejects missing prerequisites before writing, drops hidden reasoning/signatures/system prompts, sanitizes paths and payloads, validates every event, and never substitutes synthetic data. The real recording proves topology acceptance, not real semantic quality. Each implemented adapter has anonymized fixtures; duplicate/late generator variants remain covered separately by repository/environment scenarios.

## Mandatory acceptance matrix

| Scenario                          | Status                     | Evidence                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| duplicate/out-of-order/late event | automated + environment    | ingest tests; late final Docker drill; monotonic DB sequence                                                                                                                                                                                                                                                                                                        |
| file append/rotation/truncation   | automated                  | `apps/collector/tests/collector.test.ts`                                                                                                                                                                                                                                                                                                                            |
| worker crash and redelivery       | environment                | 2,048-event concurrent stale-job rebase; DB source-job idempotency                                                                                                                                                                                                                                                                                                  |
| malicious patch/prompt injection  | automated                  | reducer property tests; summarizer provider safety tests                                                                                                                                                                                                                                                                                                            |
| SSE gap/expired cursor            | implemented + environment  | outbox cursor/Last-Event-ID; expired cursor emits `resync.required`                                                                                                                                                                                                                                                                                                 |
| worker/provider outage            | environment + automated    | two-image stack with only the worker stopped (2026-08-10): all 2,048 raw events HTTP 200 across 3 pages, `/readyz` 200 `{postgres:"ok"}`, 2 backlogged jobs committed within 3 seconds after the restart; the three-image stack from before Redis was removed had readiness 503 when Redis and the worker were stopped at the same time; provider failure unit path |
| secret/stored XSS                 | automated                  | redaction tests; Playwright escaped payload; artifact attachment/CSP                                                                                                                                                                                                                                                                                                |
| backup restore                    | environment                | isolated `pg_restore`, hash/tar/count drill                                                                                                                                                                                                                                                                                                                         |
| 10k raw / 1.5k nodes              | synthetic smoke only       | `pnpm performance:smoke`; not a DB/UI SLA                                                                                                                                                                                                                                                                                                                           |
| keyboard/200%/reduced motion      | automated browser baseline | `tests/e2e/workbench.spec.ts`                                                                                                                                                                                                                                                                                                                                       |
| browser session import            | automated + environment    | `apps/api/src/import-routes.test.ts`; `tests/e2e/import.spec.ts`                                                                                                                                                                                                                                                                                                    |

A real provider canary, real macOS DMG installation/signing/notarization, and long-term DB/UI performance are still listed separately as release blockers; they cannot be substituted by the mock/synthetic evidence above.

## Reducer property tests

_The source document status is `draft`._

Generate a legal base graph, allowlist, and operation sequence, and verify: the same input gives a consistent canonical hash/result; a rejected result writes no partial entity; all memberships point at the same trace version; no illegal cycle/self-edge; pinned fields are not rewritten by the provider; tmp refs exist only within this patch; all evidence is in the allowlist.

Metamorphic cases: the ordering of unrelated operations is equivalent after canonicalization; a repeated `append_unique` is idempotent; an add followed by an update is equivalent to a canonical add; a stale base always conflicts; arbitrary string/array boundaries never cause an uncaught exception. A failing seed must be saved as an anonymized regression fixture.

Property tests supplement rather than replace concrete rule examples and database transaction integration.

## Semantic evaluation

_The source document status is `draft`._

The evaluation set is manually annotated at claim granularity for intent/action/outcome, evidence coverage, completion support, duplicate nodes, and the critical issue/repair path. Freeze the anonymized dataset and the rubric first, then compare mock/provider/prompt; a prototype percentage or a single good-looking screenshot is not used as accuracy evidence.

Core metrics: unsupported claim rate, evidence precision/recall, critical-path node recall, duplicate rate, status error, graph edit stability, raw compression ratio. Report stated and inferred separately; keep human disagreement and confidence intervals.

A real provider result must record the model snapshot, prompt/policy version, date, budget, and failure rate. Semantic quality and reducer safety are two independent gates: a legal schema does not mean the summary is correct.

## Performance methodology

The benchmark environment fixes CPU/RAM/disk, Linux, Node, the PostgreSQL image digest, the commit, and cold/warm caches. The dataset has at least 10,000 raw events and 1,500 semantic nodes, plus a 2,000-event acceptance fixture.

Measure ingest events/s and p50/p95/p99, snapshot/query, SSE backlog catch-up, revision commit, artifact range, Graph layout, and interaction frames. Provider latency/cost is reported separately and not mixed into the deterministic pipeline. Run each item several times after a warm-up, and keep the raw JSON and the commands.

`pnpm performance:smoke` is a fixed 10,000 raw / 1,500 node in-memory generation and reducer correctness smoke, whose output is explicitly marked `synthetic_smoke_not_ui_sla`. A single local run on 2026-08-03 took about 10.14ms/4.03ms, which only proves the algorithm has no obvious order-of-magnitude regression. DB ingest/query, ELK 1,500-node, and browser frame rate still have no stable multi-round raw data, so a release statement must not be written as a completed performance SLA.
