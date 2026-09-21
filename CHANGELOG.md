# Changelog

All notable project changes are recorded here. The project has no public release yet.

## Unreleased

- Initialize the Gate 0 engineering and documentation foundation.
- Implement Gate 1 canonical JSONL, OTLP JSON/gzip, Codex and Claude adapters plus import/follow checkpoints and a deterministic 2,048-event fixture.
- Implement Gate 2 raw trace list/inspector, Agent Gantt, replay watermark, evidence artifact ranges and durable resumable SSE.
- Implement Gate 3 immutable semantic revisions, deterministic reducer, mock summarization, BullMQ recovery, React Flow and ELK worker layout.
- Implement Gate 4 redaction, provider egress gates, local schema validation, OpenAI Responses and DeepSeek JSON adapters; cloud egress remains opt-in.
- Implement Gate 5 human pin/feedback revisions, deletion confirmation, backup/restore drills, synthetic scale smoke and accessibility checks.
- Add a Tauri 2 macOS Docker-service launcher and macOS universal DMG workflow; signing/notarization requires external Apple credentials.
- Override transitive dependencies to `postcss 8.5.25` and `sharp 0.35.0`; the production dependency audit reports no known vulnerabilities.
- Validate explicit local Codex/Claude imports, omit hidden reasoning/thinking and internal snapshots before persistence, distinguish CLI versions from source format versions, and add content-hash completion markers for offline imports.
- Replace structural Codex/Claude placeholders with readable visible-content previews, omit thinking-only events, preserve full sanitized payload inspection, bound summary jobs to their own chunks, paginate the complete raw event set, and throttle SSE replay refreshes.
- Prepare the repository for future public collaboration under GNU AGPL v3.0 only with a DCO contribution process, community health files, dependency update policy, third-party notices, synthetic-only README screenshots, and an external publication checklist; repository visibility remains unchanged.
- Add a privacy-first two-stage session import flow informed by a pinned Paseo design study: discover a versioned path-free catalog, opt in to bounded previews, select stale-safe opaque IDs, fully preflight each file before sending, and emit schema-validated per-session outcomes and summaries.
- Remove Redis and BullMQ from the running system: the worker now polls the PostgreSQL `summary_jobs` table directly with an in-process serial runner at concurrency 1, retry/backoff and the five-minute stuck-job lease stay in the database, and the default stack drops to two images (`postgres` plus one app image shared by the api, worker, web and migrate services). `/readyz` reports `dependencies: { postgres }` only, a published response contract change, and `REDIS_URL` is no longer accepted by the config loader.
- Simplify the repository surface: move community health files to `.github/`, consolidate the Compose stack into one root `docker-compose.yml`, isolate generated Playwright output under `.cache/`, and validate links in public community Markdown.
