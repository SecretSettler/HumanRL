---
status: accepted
owner: maintainers
last_reviewed: 2026-08-10
normative: true
milestone: Gate 0-Gate 5 and macOS distribution
---

# Operations

This document covers the Compose deployment topology, health and observability, the backup and restore drill, and the macOS Tauri shell and DMG distribution. Incident-handling steps live separately in [`operations/runbooks.md`](operations/runbooks.md).

## Deployment

The formally verified topology is a Linux x86_64 single-host Docker Compose: five services — `postgres`, plus `migrate` (one-shot), `api`, `worker` and `web`, which share one and the same application image — but only two images in the whole stack. The macOS Tauri shell reuses the same topology and requires Docker Desktop. By default only Web is published, on an ephemeral `127.0.0.1` port that Docker allocates automatically; API, PostgreSQL, worker and migrate all have no host port. PostgreSQL and artifacts each use a named volume.

There is no queue container: summary jobs are dispatched by the worker polling PostgreSQL `summary_jobs` directly, see [ADR 0014](decisions.md#adr-0014-postgresql-single-source-job-scheduling). When upgrading from an older stack that had Redis, the `--remove-orphans` of `pnpm docker:up` cleans up orphaned containers only, and the named volume has to be deleted manually once: `docker volume rm intenttrace_redis-data` (run it while the stack is stopped; nothing in the repository references it any more). The network must not be given a fixed global name or external reuse, so that the `api`/`postgres` DNS aliases of two Compose projects cannot be mixed up. PostgreSQL and the API follow the same internal-only publishing policy. Widening the network boundary requires adding authentication and a new security ADR first.

```bash
docker compose config --quiet
pnpm docker:up
pnpm docker:url
pnpm docker:status
```

`docker:up` uses Compose `--wait` and returns only after the migration has succeeded and the services that have a healthcheck are healthy, and it prints the Web, health and API status proxy addresses. When a fixed entry point is needed, `INTENTTRACE_WEB_PORT` can be set temporarily; when it is not set, Docker allocates a free port. Image versions and resolved digests are recorded in `infra/images.lock`. This deployment has no HA, no rolling upgrade, no public TLS and no auth; it must not simply be changed to `0.0.0.0` to expose host ports.

The desktop archive is produced by `pnpm desktop:prepare` and does not go into Git; the Tauri Rust side calls the Docker CLI with hard-coded arguments only and gives the frontend no general shell permission. The DMG build must happen on macOS; external distribution must additionally complete Apple codesign/notarization. Details in [macOS Tauri and DMG](#macos-tauri-and-dmg).

## Observability

The API provides `/healthz` (process), `/readyz`, `/version` and a minimal Prometheus `/metrics`; web provides `/healthz` and a readiness proxy. The `dependencies` of `/readyz` has a single entry, `postgres`; this is the published response contract in the generated OpenAPI and contains no placeholder dependency. Logs are structured server logs and redact authorization/cookie. The worker log states the polling interval and the provider; the provider-call audit keeps model/hash/usage/cost and not the body.

The current outbox/job/provider tables can diagnose watermarks, attempts, failure codes, SSE backlog and token/cost. A finer ingest/latency histogram is still a post-MVP observability enhancement; labels must not contain raw text, user paths, high-cardinality event IDs or keys.

Alerts should point at a runbook and distinguish liveness, dependency readiness and product degradation. A provider outage is not a raw browsing outage; a worker or provider failure must not mark traces already stored in PostgreSQL as lost.

## Backup and restore

A consistent backup contains the PostgreSQL dump/physical snapshot, the artifact volume and a manifest (commit, migration, image digest, per-trace artifact hashes). There is no queue storage that needs a separate backup: the job dispatch state is in `summary_jobs` and is restored together with the database, and unfinished jobs get re-claimed on their own according to `next_attempt_at` and the five-minute `running` lease.

Drill: stop writes or obtain a consistent watermark → back up DB/artifacts → start the locked version in an empty directory → restore DB → restore artifacts → migrate no-op → verify row counts/hashes/revision memberships → start the services → raw/status/SSE smoke. The original environment is kept until verification is complete.

`pnpm backup -- <directory>` creates a PostgreSQL custom dump, an artifact tar and a per-file SHA-256 manifest. `pnpm backup:verify -- <directory>` verifies the hashes/tar, restores into a temporary isolated database to cross-check trace/raw/revision counts, and finally drops the temporary database. The synthetic-environment drill passed on 2026-08-03; that is not the same as evidence of recovery from a real user disk failure. Backup files are handled as being just as sensitive as traces.

## macOS Tauri and DMG

`apps/desktop` is a Tauri 2 launcher, not a second database implementation. `pnpm desktop:prepare` produces a filtered `intenttrace-stack.tar.gz`; on its first run the bundle safely extracts it into the app local-data, looks up the Docker Desktop CLI, builds the stack with fixed `docker compose -p intenttrace-desktop` arguments, then queries the `127.0.0.1` Web port Docker allocated dynamically and opens `/traces`. The frontend has no general shell permission.

Local macOS build: install the Xcode Command Line Tools, Rust, Node/pnpm and Docker Desktop, then run:

```bash
pnpm install --frozen-lockfile
pnpm desktop:prepare
pnpm --filter @intenttrace/desktop tauri build --target universal-apple-darwin --bundles dmg
```

`.github/workflows/macos-dmg.yml` provides a manual universal build. External distribution must configure `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` and keep codesign/notarization/staple/install evidence; an artifact built without credentials can only serve as an internal unsigned build and must not be called a release. Launching the DMG still depends on Docker Desktop, and only macOS 12+ with a desktop width of at least 1024px is supported.

The Linux evidence covers only JSON/CSP, Rust formatting, the Cargo dependency lock and the resource archive; the Tauri WebKit native compile, the DMG and the Apple signature/notarization are all separate macOS gates.
