---
status: accepted
owner: security
last_reviewed: 2026-08-11
normative: true
milestone: Gate 0-Gate 5
---

# Security

This document merges the threat model, the data-handling boundary and the provider egress policy. Together the three sections define how the product boundary "no cloud egress by default, no home scanning, no hidden reasoning fields" is concretely enforced.

## Threat model

Assets: user traces, source-code/terminal artifacts, provider keys, the database, semantic claims, Collector checkpoints. Trust boundaries: host filesystem→Collector, browser (the files the operator explicitly selects)→web proxy→API, Collector/OTLP→API, database→web, event sketch→provider, provider patch→reducer, browser→artifact renderer.

Main threats: reading outside the explicit paths or symlink escape; secrets in a payload leaking through logs or the provider; stored XSS; prompt injection from documents or logs; a source ID collision rewriting facts; a malicious patch forging evidence/cycles/pins; SSE privilege escalation or an old cursor mixing streams; Docker ports accidentally exposed to the public internet; backup leakage.

The browser→API boundary accepts only bytes handed over by the file picker; neither route accepts a server path or enumerates a directory. Full payloads use `application/vnd.intenttrace.session-bundle` under `IMPORT_UPLOAD_MAX_BYTES` (64 MiB by default). `ITB1` parsing caps the manifest at 1 MiB, requires strict UTF-8 JSON, normalized unique relative paths/client refs, positive ranges declared in offset order, and exact non-overlapping payload coverage. JSON candidate protocol v2 permits at most 5,000 metadata parts, 50 roots plus reachable companions, 64 KiB per text head, and 4 MiB aggregate decoded heads. Oversize/wrong-media requests return 413/415 before parser work.

Existing mitigations: a single dynamic loopback entry point, no file reads in the API, explicit paths plus symlink rejection in the Collector, the upload size cap with explicit 413/415 mapping, multi-condition provider gating and a domain allowlist, log and egress redaction, strict schemas, a deterministic reducer, a claim evidence allowlist, attachment artifacts, confirmation-style deletion and backup hashes. The residual risks are the lack of local authentication, no application-layer encryption of the host or volumes, Docker Desktop permissions, uploaded bytes residing in memory in full in three places (browser/Next/Fastify), and no provider canary run in an environment with a real key; loopback does not make trace content trustworthy.

## Data handling

Only traces the operator explicitly imports are collected. The API never scans directories. The Collector walks only an explicitly named file/directory root using source-specific allowed companion extensions. Every part must stay inside the realpath boundary, reject symlinks, and pass `O_NOFOLLOW` pre/post inode, size, and mtime checks. Public catalog IDs bind the authorized root and part identities without exposing names, paths, or native session IDs.

All parts in every selected candidate finish `prepareSessionParts` parser/Zod/artifact-key preflight before writes begin. The browser and Collector compute `sourceIdentity = "bundle-" + aggregateContentSha256.slice(0,32)`, so the same relative paths and bytes retain cross-transport identity. Candidate IDs depend only on source, logical root identity, and sorted relative paths; the API recomputes them from supplied bytes and rejects stale/missing IDs before inserting any candidate. Referenced artifacts are registered before canonical UUID substitution and ordered event ingestion.

Sensitive payload bodies and absolute paths never enter public diagnostics. Incomplete text heads are cut at the last complete newline; incomplete OpenCode JSON heads are rejected rather than guessed. Missing bundle companions fail visibly as `preflight_failed`. Folder imports retain relative file-picker paths only inside the explicit upload frame; the server still has no host-filesystem capability.

Session bundle adapters preserve the explicit-byte boundary: Codex, Claude, OpenCode, OMP, and Grok parts are normalized relative paths and are never resolved against server directories. OpenCode temporary databases use fixed private filenames and are deleted in `finally`; WAL bytes are required for uncheckpointed rows. Fixtures contain only anonymized IDs, no secrets, host paths, thinking/reasoning fields, or raw encrypted content.

Product telemetry and build-tool telemetry must be stated separately. IntentTrace's own code contains no analytics client, crash reporter or usage ping, and reports nothing to this project or to a third party at install, start or run time. But Next.js and Turborepo each enable anonymous build telemetry by default, and `pnpm build` is exactly `turbo run build`: therefore `infra/Dockerfile` (both the builder and the runtime stage), `docker-compose.yml` and `.github/workflows/ci.yml` all set `NEXT_TELEMETRY_DISABLED=1` and `TURBO_TELEMETRY_DISABLED=1` explicitly, so that the documented `pnpm docker:up` path and the gates send nothing over the network. Running `pnpm build`/`pnpm dev`/`pnpm typecheck` directly on the host rather than through Docker is still subject to the vendors' defaults; that is a fact about the environment, not a switch this repository can turn off on your behalf. The recommended practice is to export those same two environment variables, because it has no side effects. The vendors' own `pnpm exec turbo telemetry disable` and `pnpm exec next telemetry disable` also work, but both write `cache/config.json` and `apps/web/cache/config.json` under the repository working directory; neither path is currently in `.gitignore` or in `.prettierignore`, so they make `pnpm format:check` fail — delete them once you are done.

Fixtures must be synthetic or irreversibly anonymized, and keep a provenance manifest. `.env`, the artifact volume, database dumps and real Codex/Claude sessions do not go into Git; real file paths, session IDs and conversation bodies are not written into progress evidence either. Backups get access control; the current local demo does not implement encryption-at-rest, and users must rely on host/volume permissions.

## Provider egress policy

The default and the tests are both `PROVIDER_MODE=mock` and `PROVIDER_EGRESS_ENABLED=false`. When `openai|deepseek` is selected, the loader requires egress=true, a positive budget, a key and an explicit model all at once, and restricts the host to `api.openai.com` or `api.deepseek.com`. Event-sketch truncation, secret redaction, the prompt-injection data boundary, the timeout, the local Zod/reducer and the raw-only failure path are all enforced before and after the network call.

Allowed to send: short summaries processed under a versioned policy, the necessary ID aliases and structural information. Forbidden by default: source code/complete diffs, complete documents, whole terminal logs, environment variables, credentials, cookies, absolute user paths, hidden reasoning fields. A provider response is always untrusted input.

There is no automatic fallback across providers; a timeout, a 429, the budget, HTTP or bad JSON all fall back to raw-only and emit `summary.failed`. The registry recorded the price sources for `gpt-5.6-sol` and `deepseek-v4-flash/pro` on 2026-08-03; the worker records the explicit model, the request/response hashes, tokens/cost and the egress report. Repository acceptance is not configured with a key, so there is no evidence of a paid call.
