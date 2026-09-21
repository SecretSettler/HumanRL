---
status: accepted
owner: architecture
last_reviewed: 2026-08-10
normative: true
milestone: Gate 0-Gate 5
---

# Architecture

This document merges the system boundary, the invariants that must always hold, and the ordering of the three chains: import, semantics and browsing. The overview describes component responsibilities, the invariants are constraints that no implementation may violate, and the data flow gives the concrete ordering of each chain.

## Architecture overview

The system splits into the fact layer ETG and the derived layer EIG. The Collector reads only the paths the operator names explicitly and submits the input to the API; the API validates, assigns a per-trace monotonic `ingestSeq`, and transactionally writes raw event/command/outbox; the worker processes summary commands at-least-once; the provider can only propose patches; the deterministic reducer validates and then commits as an immutable revision; the web presents through REST snapshots and durable SSE.

PostgreSQL is the authority for facts, revisions, job idempotency and the outbox, and is at the same time the only source of job dispatch: there is no external queue, and the worker polls `summary_jobs` directly. The ArtifactStore holds raw payloads/large objects, defaults to a filesystem named volume, and keeps room in its interface for an S3 adapter. Graph layout is computed in a web worker and respects pinned/stable incremental positions.

The API currently exposes the actually implemented `/api/v1/events`, trace/raw/snapshot/graph/artifact/provider audit/human edit/delete, `POST /api/v1/imports/candidates` and `POST /api/v1/imports/sessions`, durable SSE, and OTLP `POST /v1/traces`; the generated OpenAPI is the source of truth for routes. Browser import handles only the bytes the operator explicitly hands over, and shares the same preflight core and the same trace identity with the Collector, so the two paths are mutually idempotent. The worker polls `summary_jobs` at a fixed interval with an in-process serial runner; the PostgreSQL job claim, input hash, base revision and commit transaction are the idempotency authority. The Tauri shell does not replicate the database to a host port; instead it starts the same isolated Compose stack.

## System invariants

1. Raw execution events are append-only facts; start, end, correction and trace complete are all new facts, and in-place modification is forbidden.
2. Raw payloads are persisted only as hash/ref; the database envelope keeps source, lineage, time, status and artifact refs.
3. Each trace's `ingestSeq` is assigned monotonically by a PostgreSQL transaction; the same source identity plus the same hash is idempotent, a different hash is `409 integrity_conflict`.
4. The EIG can be deleted and rebuilt; logical node/edge IDs are stable, versions are immutable, and revision membership reuses unchanged versions.
5. The provider never writes to the database; it can only emit patches constrained by nonce, base revision, allowlist and schema.
6. The reducer independently computes confidence, status, cycle, dedupe, pin and evidence; a model suggestion is not a committed fact.
7. Raw insert, summary command, revision commit and SSE outbox each commit atomically within their corresponding PostgreSQL transaction.
8. A worker/provider failure does not break queries over already ingested raw data; a provider failure falls back to raw-only.
9. By default there is no cloud egress, no home scanning, no automatic reading of real sessions, and no hidden chain-of-thought.
10. All externally reachable ports bind to loopback only; before that constraint changes, an auth/threat-model ADR must be added.

## Data flow and ordering

Import: operator → Collector explicit path validation → adapter normalize → API transaction (identity check, `ingestSeq`, raw envelope, artifact metadata, summary command, outbox) → REST response. A repeated delivery first compares the canonical payload hash; an identical hash returns the original server ID, a different one returns an integrity conflict.

Semantics: the worker polls `summary_jobs` and atomically claims a command → reads the event sketch within the watermark → creates a nonce/input hash → the mock or an allowed provider returns a patch → the reducer resolves schema/allowlist/base revision → a single transaction writes immutable versions, revision membership, job result and SSE outbox → the same transaction sets the job to `committed`. A redelivery returns the existing result by input hash + base revision.

Browsing: the web requests a snapshot first, then establishes SSE with the snapshot cursor; events are applied by outbox ID. On disconnect it passes `Last-Event-ID` or `?cursor=`; gaps are backfilled, and a cursor beyond retention returns an explicit error and re-fetches the snapshot. A late raw event appears at the new ingest watermark; if a final already exists it is marked stale, and a new final revision is then produced.
