---
status: current
owner: maintainers
last_reviewed: 2026-08-10
normative: true
milestone: Gate 0-Gate 5 and post-Gate 5
---

# Decisions

This document collects all 14 ADRs, preserving each one's original decision text and its own status line; once an ADR is Accepted its conclusions are no longer rewritten, and a supersession is declared by a new ADR. The [ADR index](#adr-index) at the end of the document gives quick navigation by topic and the current supersede relationships.

## ADR 0001: ETG and EIG layering

_Status: accepted · owner: architecture · last_reviewed: 2026-08-01 · milestone: Gate 0_

Decision: the Execution Trace Graph holds immutable observed facts; the Evidence-backed Intent Graph is a rebuildable, versionable interpretation layer that chains every claim back to the ETG. The reason is that comprehensibility must not contaminate fidelity data. The cost is two-layer storage and revision management; the benefit is that provider changes, human revisions and recomputation do not rewrite execution history.

## ADR 0002: Contract source of truth

_Status: accepted · owner: architecture · last_reviewed: 2026-08-01 · milestone: Gate 0_

Decision: Zod is the single source for domain/API schemas, and Drizzle plus committed migrations are the persistence source of truth; JSON Schema/OpenAPI must be generated from code and pass a drift check. Accepted ADRs explain the rules that types cannot express. Historical JSON Schema does not take part in runtime validation directly, which avoids hand-written copies diverging.

## ADR 0003: Immutable revisions and watermarks

_Status: accepted · owner: architecture · last_reviewed: 2026-08-01 · milestone: Gate 0_

Decision: logical IDs and version IDs are separate; a revision stores its parent, a `live|final|human` branch and an event watermark, and reuses versions through the membership table. Replay uses the ingest/revision commit watermark to represent what was known at the time, and source time only determines the position on the timeline. A late event makes a final stale and is corrected by a new final, without overwriting history.

## ADR 0004: Deterministic reducer

_Status: accepted · owner: architecture · last_reviewed: 2026-08-01 · milestone: Gate 0_

Decision: the provider submits only patches carrying a schema version, nonce, base revision, tmp refs and explicit operations. The reducer commits after validating schema, allowlist, evidence, artifact/agent refs, cycle, status, dedupe, pin, direction and confidence. The same input must produce the same result; bad output must not leak into the official graph as proposed nodes.

## ADR 0005: Content-addressed ArtifactStore

_Status: accepted · owner: architecture · last_reviewed: 2026-08-01 · milestone: Gate 0_

Decision: large objects use SHA-256 content addressing and are stored by default in a local named volume. The public interface is fixed at `put`, `stat`, `getRange` and `deleteTrace`, and an S3 adapter can be added later. MinIO is not a default dependency because of its distribution and maintenance status. The database keeps only hash, length, media type and ref; deletion is isolated per trace.

## ADR 0006: PostgreSQL idempotency and outbox

_Status: accepted · owner: architecture · last_reviewed: 2026-08-01 · milestone: Gate 0_

Decision: BullMQ is used at-least-once, and correctness is guaranteed by PostgreSQL input hash, base revision and unique constraints. Raw insert/command, revision/job result and SSE event each share a transaction with their business write. Losing Redis allows delivery to be rebuilt; nothing may be acked before the database commits.

## ADR 0007: REST snapshots and durable SSE

_Status: accepted · owner: architecture · last_reviewed: 2026-08-01 · milestone: Gate 0_

Decision: the MVP uses `/api/v1` REST for reads and writes and SSE for increments, without introducing WebSocket. OTLP keeps the standard `POST /v1/traces`. SSE IDs come from the durable outbox and support `Last-Event-ID` and `?cursor=`; a cursor older than the retention window first emits `resync.required` and then backfills from the earliest available event. The generated OpenAPI lists only real routes.

## ADR 0008: pnpm TypeScript monorepo

_Status: accepted · owner: architecture · last_reviewed: 2026-08-01 · milestone: Gate 0_

Decision: pnpm workspace + Turbo manage the Next web, Fastify API, BullMQ worker, Collector and shared packages. Versions are pinned exactly, and CI uses a frozen lockfile. The boundary packages carry schema, config, db, storage, ingest, adapter, summarizer, reducer, layout, UI and fixtures respectively, and copying contracts across layers is forbidden.

## ADR 0009: Local single-user and loopback

_Status: accepted · owner: security · last_reviewed: 2026-08-03 · milestone: Gate 0_

Decision: the first release has no auth/RBAC/tenant. The default Compose publishes only the web on a `127.0.0.1` port automatically assigned by Docker; the API, PostgreSQL and Redis are reachable only inside the private bridge. Explicitly fixing the web port still binds to loopback only. This is a deployment boundary, and does not mean input is trusted: XSS, path, prompt injection and secret redaction protections are still required. Any public-internet or LAN exposure must first add authentication, CSRF/CORS, tenant isolation and a threat model.

## ADR 0010: Provider egress safety gate

_Status: accepted · owner: security · last_reviewed: 2026-08-01 · milestone: Gate 0_

Decision: `PROVIDER_MODE=mock` and `PROVIDER_EGRESS_ENABLED=false` are enforced by default. A real provider is enabled only when egress, an allowlisted host, a key, an explicit model and a positive budget are all satisfied at once; redaction/event cap happen before sending, and local schema/reducer after the response. There is no automatic fallback; timeout, 429, budget or bad JSON degrade to raw-only and do not block ingestion.

## ADR 0011: Standalone Collector

_Status: superseded · owner: security · last_reviewed: 2026-08-06 · milestone: Gate 0_

Decision: the API does not read host directories. The Collector CLI handles only what `--path` explicitly authorizes, never scans home, and rejects symlink boundaries by default; the checkpoint records realpath, file identity, offset and prefix hash in order to recognize append/rotation/truncation. The implementation imports an explicit file, or one level of regular files under an explicit directory; follow is allowed only for a single Codex/Claude file.

Status: the conclusions on a standalone Collector, explicit authorization, the API not scanning host directories, and symlink rejection remain in force; the "one level of regular files / direct import" implementation limit is replaced by the recursive, two-phase guided import of [`0012`](#adr-0012-two-phase-session-import-inside-explicitly-authorized-roots).

## ADR 0012: Two-phase session import inside explicitly authorized roots

_Status: accepted · owner: ingestion · last_reviewed: 2026-08-06 · milestone: post-Gate 5 import UX_

### Context

ADR 0011 established a permission boundary that cannot be broken through: the API does not read host directories, and the Collector handles only paths the operator names explicitly. Later real use showed that bulk-importing the files in a directory, or listing file names with `--dry-run`, is not enough to support hundreds of Codex/Claude sessions: the operator cannot tell, before raw facts are sent, whether a session is readable, which project it belongs to, or when it was active, and cannot reliably select a few sessions. When the tail of a file is corrupt, parsing and sending at the same time can also leave a half-imported trace.

Research into Paseo's provider-session import shows that a mature import flow should be split into two phases, a lightweight listing and a selected import, and should connect CLI/UI through stable handles, bounded descriptors, failure isolation and explicit empty/error states. For detailed sources and a difference analysis see [`design/research/import-experience.md`](design/research/import-experience.md).

### Decision

1. **The permission boundary is unchanged**: the API/worker/web server do not scan the host filesystem; the Collector does not read home automatically. In the local MVP the Collector's ingestion origin allows only `localhost`, IPv4 `127.0.0.0/8` or IPv6 `::1`, which prevents a misconfiguration from sending raw sessions to a remote host. Every discovery/import must have a regular file or directory root that the operator names explicitly, and symlinks are rejected at every level.
2. **Two-phase protocol**:
   - `discover` generates a versioned `SessionCatalog` inside the authorized root, without contacting the API, writing a checkpoint, or sending raw facts;
   - `import --session <opaque-id>` can be given catalog IDs repeatedly, imports only the selected candidates, does not use a native path/session ID as a public selector, and does not re-run a content search at import time.
3. **Minimal catalog disclosure**: by default a descriptor contains only the opaque ID, source, generic title, project basename hint, activity/mtime, and byte/event/warning counts; absolute paths, root-relative paths, file names and native session IDs do not reach stdout. Only after an explicit `--include-previews` opt-in are a bounded visible first/last prompt preview and the content title emitted; hidden reasoning/thinking never enters the catalog.
4. **Stale selection fails visibly**: an opaque ID binds a local selection context of source, authorized root, root-relative placement, size, mtime and file identity. Once the candidates change the old ID no longer matches and the catalog must be refreshed; an old preview must never silently point at a changed file.
5. **Full preflight**: every file must complete adapter parse, privacy omission and Zod validation before the first raw fact is sent. A malformed/unsupported/visible-event-empty candidate sends 0 events; the other files in the same batch continue. A stat/realpath/race/out-of-bounds candidate is counted into `rejectedFiles` and makes the command exit non-zero, and must not disappear silently. If the API fails partway through sending a single file, a prefix of raw facts may still be left behind; those are observed facts that cannot be overwritten, and a retry relies on source identity idempotency to fill in the rest.
6. **Bounded resources**: metadata is read first with at most 32-way concurrency, all candidates are sorted and trimmed to the limit, and only the recent/selected window is then inspected; discovery keeps descriptors only, import runs preflight→send file by file at bounded concurrency, and the memory ceiling is determined by concurrency and single-file size, not by the total number of files in the directory. The per-file default cap is 64 MiB, adjustable explicitly with `--max-file-mib`, and a candidate over the cap fails before it is read.
7. **Contract source**: `SessionCatalogSchema`, `SessionImportOutcomeSchema` and `SessionImportSummarySchema` live in `packages/schema` and generate JSON Schema; the catalog, the per-session success results and the aggregate summary must pass the schema before being written to stdout. A future Tauri/web picker may only consume this catalog/progress protocol, and must not bypass the Collector to let the API scan directories.
8. **Compatibility**: the existing bulk import without `--session`, together with `--max-files`, `--newest`, `--concurrency`, `--dry-run` and single-file `follow`, are retained. `dry-run` is upgraded to a full preflight catalog, but does not emit prompt previews by default.

### Consequences

Benefits: import is verifiable, selectable and scriptable beforehand; a bad file does not produce an adapter-level half import; stdout does not leak home path/native ID/prompt by default; a future graphical picker has a stable contract. Costs: discovery reads and parses the candidates within the limit, which is slower than pure `stat`; a catalog ID is a short-lived selector scoped to the local authorized root, not a durable domain identity; sending a single file to the API is still not an atomic transaction across events.

ADR 0012 replaces the "one level of regular files / direct import only" implementation limit in ADR 0011, but does not replace its conclusions on a standalone Collector, explicit authorization, the API not reading host directories, and symlink rejection.

## ADR 0013: Browser-delivered session upload

_Status: accepted · owner: ingestion · last_reviewed: 2026-08-09 · milestone: post-Gate 5 import UX_

### Context

The two-phase guided import established by ADR 0012 has a CLI entry point only. The web UI's entire import surface is a non-copyable `<pre>` list of commands in the `/traces` empty state, so the operator has to leave the browser, put together the authorized root path, and come back and refresh. At the same time three of the four adapters accept only line-delimited JSONL, so a whole-document `.json` session is rejected with `MalformedAdapterInputError`.

The key distinction: **bytes the operator explicitly selects and hands over in the browser are not a host directory scan.** The file picker is owned by the user agent, and a web page can only obtain the `File` a user actively hands over. This boundary is fully compatible with "the API does not scan the host filesystem" in ADR 0012 §1.

### Decision

1. **The permission boundary is unchanged**: the API still does not enumerate any directory. The two new routes handle only the bytes that have already arrived in the request body, accept no path parameter, and perform no filesystem read. ADR 0012 §1 and §7 continue to hold; a server-side directory picker is still forbidden.
2. **Shared preflight core**: `prepareSessionBytes` in `packages/adapters/src/session.ts` is the only parsing entry point for both the CLI and the upload path — a full parse + Zod validate first, and only then does the caller emit the first raw fact. The Collector's `prepareSession` keeps the fs half (size gate, `O_NOFOLLOW`, identity/size/mtime recheck before and after the read) and then delegates to it.
3. **The same trace identity**: `buildCompletionMarker` derives the `sourceEventId` of `trace_complete` from the file's SHA-256 rather than from the transport. A file already imported by the CLI, re-uploaded in the browser, yields `inserted: 0` and the same `traceId`; the reverse holds too. The two paths are mutually idempotent.
4. **Previews are opt-in**: `POST /api/v1/imports/candidates` returns a generic title and `null` previews by default, and only `includePreviews: true` returns the content title and a bounded first/last prompt preview, capped at 160 characters, sharing one implementation (`redactCatalogEntry`) with the catalog's `--include-previews`. Hidden reasoning/thinking never enters a candidate.
5. **Bounded head inspection**: candidate inspection reads only the first 64 KiB of each file, at most 50 candidates per request, and an incomplete head is truncated at the last newline. The inspection route writes nothing, and issues a single database query (`listTracesByIds`) to decide whether something is already imported.
6. **The upload cap is a configuration key**: `IMPORT_UPLOAD_MAX_BYTES` defaults to 64 MiB, matching the collector's `DEFAULT_MAX_FILE_MIB`. Exceeding it is mapped by Fastify's `FST_ERR_CTP_BODY_TOO_LARGE` to 413 `payload_too_large`, and a mismatched media type is mapped to 415 `unsupported_media_type` — both of which previously turned incorrectly into 500.
7. **Container JSON**: `readSessionRecords` adds two branches, a top-level array and a single pretty-printed object, on top of the existing JSONL parsing. JSONL input takes the first branch, `line`/`bytes` are unchanged byte for byte, and the fallback `sourceEventId` of already-imported traces therefore stays stable. Only input that previously threw reaches the container branches; when it still cannot be parsed the original `parseJsonLines` error is rethrown, so the collector's `preflight_failed` redaction path is unaffected.
8. **The file name is used only for sourceIdentity**: `safeIdentifier(basename(fileName))` produces the same value the collector derives from the on-disk basename, so a browser import and a CLI import of the same file land in the same project. The file name does not enter the descriptor, and is not echoed into catalog output.

### Consequences

Benefits: import works without installing the CLI; the same file has the same identity on both paths; 413/415 gain real semantics; `.json` sessions are no longer rejected. Costs: the uploaded bytes reside fully in memory in three places — the browser `File`, Next's `arrayBuffer()` and Fastify's `Buffer` — which is an acceptable trade-off for a loopback single-user MVP, and is also why the cap is a configuration key rather than a constant; head inspection reports `preflight_failed` for a whole-document JSON larger than 64 KiB with no newline, but that candidate is still importable, because the upload path re-detects on the full bytes.

This ADR does not replace ADR 0012; it adds, within the same permission boundary, one more entry point where the operator delivers the bytes.

## ADR 0014: PostgreSQL single-source job scheduling

_Status: accepted · owner: architecture · last_reviewed: 2026-08-10 · milestone: post-Gate 5 runtime slimming_

### Context

Since Gate 3, summary job dispatch has been written as a "dequeue from PostgreSQL → enqueue into Redis → fetch back in the same process" round trip: every 2 seconds `apps/worker/src/main.ts` calls `listRunnableSummaryJobIds()` to take the pending IDs out of PostgreSQL, writes them into Redis with `queue.add()`, and a BullMQ `Worker` with `concurrency: 1` inside the same process takes them back and runs them. Both ends of the queue are in the same process.

Reviewing this chain confirmed: **retry, backoff and crash recovery do not go through BullMQ at all**.

- `failSummaryJob` sets a job to `status='failed'` and sets `next_attempt_at = now() + 5s`; a patch rejected by the reducer and a budget/provider rejection take `retry=false` and are set to `status='cancelled'` with `next_attempt_at = null`, which is a cancellation rather than a retry.
- The query in `listRunnableSummaryJobIds` picks up both `pending`/`failed` jobs whose `next_attempt_at` is due and jobs with `status='running'` whose `updated_at` is older than 5 minutes — the latter is exactly the reaper for killed workers. `claimSummaryJob` performs a conditional atomic `UPDATE` with the same set of conditions, and increments `attempt_count`.
- The BullMQ side never configured `attempts` (1 by default), and both `removeOnComplete` and `removeOnFail` are `true`, so it neither retries nor keeps dead letters.

In other words, the queue layer carried no correctness or availability responsibility; it merely detoured an in-process function call into a network round trip, at the cost of a third runtime dependency, a third pinned image and the sixth Compose service that came with it, a native addon (`msgpackr-extract`, pulled in via `bullmq` → `msgpackr`), a configuration key, a health dimension and a stretch of threat surface. For the full evidence and implementation scope see [the runtime slimming and queue removal design](design/research/slim-runtime-and-queue-removal.md).

### Decision

1. **PostgreSQL `summary_jobs` is the only source of dispatch.** There is no second delivery medium; the job state machine, backoff and lease reaping are all expressed by that table; the conditional `UPDATE` in `claimSummaryJob` is the only claiming authority.
2. **Scheduling is an in-process serial runner.** `createSummaryRunner().runDueJobs()` in `apps/worker/src/runner.ts` processes all of the current round's due jobs in order, `apps/worker/src/main.ts` drives it by polling at `SUMMARY_POLL_INTERVAL_MS` (2000 ms), and an in-flight gate skips a tick while the previous round is still running. Concurrency stays at 1, matching the removed BullMQ `concurrency: 1`. Polling latency is still at most 2 seconds, the same as before the removal, and is not a regression.
3. **Crash recovery is carried by leases rather than by a queue.** A `running` row left behind by a killed worker is selected again after five minutes; backoff retries are driven by `next_attempt_at`. Both of these were already the only paths in effect before the removal.
4. **The dependency set of `/readyz` shrinks to `{ postgres }`.** This is a **change to a published response contract**, reflected in the generated [OpenAPI](contracts/api/openapi.yaml). No `redis: "skipped"` placeholder is kept: the generated contract exposes only the dependencies that really exist, and returning a nonexistent dependency indefinitely is a dishonest description. The only current consumers are the web status page and the Compose `api` healthcheck inside this repository, and both only check the status code and do not read the `dependencies` structure.
5. **The default stack has only two images.** `postgres` and one application image; the four services api/worker/web/migrate share the same set of layers of that image, and together with `postgres` that is five Compose services (`migrate` is one-shot). `infra/images.lock` correspondingly pins only two digest-pinned images.
6. **PostgreSQL job claiming is still the correctness authority.** Input hash, base revision, job nonce, unique constraints and single-transaction commit are unchanged, so ADR 0006's conclusions on idempotency and the outbox hold as they are, and are stronger after an at-least-once intermediate layer has been removed.

### Superseded scope

This ADR supersedes **only** the following three queue-transport-related clauses; all the other conclusions of the three ADRs continue to hold:

| ADR                                                                        | Superseded clause                                                           | What continues to hold                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`0006`](#adr-0006-postgresql-idempotency-and-outbox) transactional outbox | "BullMQ is used at-least-once" "Losing Redis allows delivery to be rebuilt" | PostgreSQL input hash / base revision / unique constraints guarantee correctness; raw insert, revision/job result and SSE event each share a transaction with their business write; nothing may be acked before the database commits |
| [`0008`](#adr-0008-pnpm-typescript-monorepo) TypeScript monorepo           | "BullMQ worker" in the composition list                                     | the pnpm workspace + Turbo layout, exact version pinning, frozen lockfile, boundary-package layering and the ban on copying contracts across layers                                                                                  |
| [`0009`](#adr-0009-local-single-user-and-loopback) loopback single-user    | "Redis is reachable only inside the private bridge"                         | no auth/RBAC/tenant at first release; only the web is published to `127.0.0.1`; the API and PostgreSQL have no host port; any public-internet/LAN exposure must first add authentication and a threat model                          |

The bodies of the three original ADRs are not modified, which conforms to the repository rule that "once Accepted, conclusions are not rewritten".

### Consequences

Benefits: external runtime dependencies drop from three to two; the dispatch chain loses one network round trip and one native addon; `/readyz` and OpenAPI describe only the dependencies that really exist; the troubleshooting surface converges onto a single table that can be queried directly with SQL (see [Runbook: Summary job queue](operations/runbooks.md#runbook-summary-job-queue)).

Costs: **there is no longer a ready-made path for horizontally scaling workers across hosts.** After the queue is removed the worker and the API can only coordinate through the shared database, and the repository no longer ships any distributed delivery component with the stack. ADR 0009 already fixed the first release as single-host single-user, so this is a YAGNI trade-off consistent with the existing boundary rather than a new technical limitation: `claimSummaryJob` is a conditional atomic `UPDATE`, `summary_jobs` already supports multiple consumers, and when scaling really is needed later, multiple processes (or even multiple hosts connected to the same PostgreSQL) can contend for the same table directly, or a queue can be reintroduced with a new ADR.

The `/readyz` contract change is breaking for consumers outside the repository; there are currently no consumers outside the repository, so the risk is confined to this repository.

## ADR index

_Status: current · owner: architecture · last_reviewed: 2026-08-10 · milestone: Gate 0_

Accepted: [`0001`](#adr-0001-etg-and-eig-layering) dual graphs, [`0002`](#adr-0002-contract-source-of-truth) contract source of truth, [`0003`](#adr-0003-immutable-revisions-and-watermarks) revisions, [`0004`](#adr-0004-deterministic-reducer) reducer, [`0005`](#adr-0005-content-addressed-artifactstore) artifacts, [`0006`](#adr-0006-postgresql-idempotency-and-outbox) outbox, [`0007`](#adr-0007-rest-snapshots-and-durable-sse) REST/SSE, [`0008`](#adr-0008-pnpm-typescript-monorepo) monorepo, [`0009`](#adr-0009-local-single-user-and-loopback) loopback, [`0010`](#adr-0010-provider-egress-safety-gate) provider gate, [`0012`](#adr-0012-two-phase-session-import-inside-explicitly-authorized-roots) two-phase guided import, [`0013`](#adr-0013-browser-delivered-session-upload) browser-delivered session upload, [`0014`](#adr-0014-postgresql-single-source-job-scheduling) PostgreSQL single-source job scheduling. The permission boundary of ADR 0011 is retained by 0012, and its old one-level file implementation limit has been superseded. ADR 0014 supersedes only the queue-transport-related clauses in 0006, 0008 and 0009; 0006's PostgreSQL idempotency/outbox conclusions and 0009's loopback boundary continue to hold.

Once an ADR is Accepted its conclusions are not rewritten; a replacement creates a new ADR and marks the old one superseded. Draft interfaces do not enter the actual OpenAPI.
