---
status: current
owner: maintainers
last_reviewed: 2026-08-11
normative: true
milestone: Gate 0-Gate 5
---

# Development

This document covers the development environment, the contribution flow, the repository layout, and the quality/release process. The four sections are ordered as "get it running first, then commit, then locate the code, and finally pass the gate".

## Getting started

Requires Linux x86_64, Node `24.18.1`, pnpm `11.18.0` (Corepack), and Docker/Compose. Do not copy real provider keys or sessions.

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm docker:up
pnpm docker:url
pnpm demo:load
```

By default the entire stack runs inside Docker, and the command prints the one dynamic loopback web address. `demo:load` imports only the committed 691-event, nine-lane IMO recording with eight canonical spawns and joins; the separate fixed-seed 2,048-event/six-agent synthetic fixture is `demo:load:synthetic`. Regenerate the recorded fixture only from an explicit verified session root with `pnpm --filter @intenttrace/test-fixtures regenerate:imo-demo -- <session-root>`; the recorder refuses missing root/child transcripts and has no synthetic fallback. The collector first uses `… dev discover --source … --path …` to return a versioned catalog, with no prompt bodies by default, inside an explicitly authorized root, and then uses `… dev import --source … --path … --session <opaque-id> --api <web-origin>` for a precise import; `--session` may be repeated. It does not scan home automatically, rejects a symlink at every level by default, and sends normalized events to the web internal proxy only after a complete preflight. The original bulk import without a selector is still supported but must be requested explicitly.

The API and PostgreSQL are connected only through the Compose project-scoped private network (the default project is `intenttrace_default`) and service DNS names; their in-container ports are 3001 and 5432 respectively, and the host has no corresponding listener. The default stack has only `postgres` plus api/worker/web/migrate sharing one application image. Different `-p` projects own independent networks/volumes, which avoids same-name DNS pollution between the desktop shell, the clean acceptance stack, and the development stack. Use an explicit, temporary Compose override only when debugging a host process is genuinely required; a fixed database port must not be added back into the default topology.

Source checks and builds can still run on the host. Back up with `pnpm backup -- <dir>`, and run restore drills with `pnpm backup:verify -- <dir>`. The macOS shell runs `pnpm desktop:prepare`; a real DMG can only be built by running `pnpm desktop:build` on macOS. Run the full local and CI quality gates before committing.

## Contribution flow

The project uses GNU AGPL v3.0 only (SPDX: `AGPL-3.0-only`) and the Developer Certificate of Origin 1.1; through `git commit -s` a contributor declares the right to submit the contribution under the project license. A branch/commit focuses on one reviewable boundary. For a design decision, write or update an ADR first; for a behavior change, add the contract/fixture first, then implement it; a dependency upgrade is a separate commit and records the license and migration impact. [`.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md) is the full process for external contributors.

A PR description writes implemented, automated verified, environment verified, deferred, and blocked separately. Static checks, mock fixtures, Compose smoke, and real provider/user-environment evidence must not be conflated. A screenshot proves only the interface it shows; it does not prove that the backend semantics are correct.

Security issues follow [`.github/SECURITY.md`](../.github/SECURITY.md); do not paste keys, real sessions, complete terminal logs, or unanonymized code into an issue or fixture.

## Repository guide

`apps/web` is the status page and the Trace Workbench, `apps/api` is the Fastify REST/OTLP/SSE service, `apps/worker` is the asynchronous semantic pipeline, `apps/collector` is the explicit-path CLI, and `apps/desktop` is the Tauri Docker launch shell. Shared packages are layered by dependency direction: schema/config → db/storage/ingest/adapters → summarizer/reducer/layout/ui/fixtures. An app may compose packages; a lower-layer package does not depend on an app.

Root scripts are grouped by operational responsibility:

| Directory         | Responsibility                                            |
| ----------------- | --------------------------------------------------------- |
| `scripts/checks/` | Static and synthetic checks                               |
| `scripts/data/`   | Explicit data-maintenance commands                        |
| `scripts/demo/`   | Demo loading and README screenshot capture                |
| `scripts/ops/`    | Docker, desktop packaging, backup, and restore operations |

Repository artifacts fall into three classes:

- **Tracked source:** authored application, package, script, configuration, test, fixture, and normative documentation files.
- **Committed generated artifacts:** JSON Schema under `packages/schema/generated/`, OpenAPI under `docs/contracts/api/`, and Drizzle migrations under `packages/db/migrations/`. Regenerate rather than hand-edit them, and commit their changes with the source contract.
- **Disposable local output:** `node_modules/`, `dist/`, `.turbo/`, `.next/`, `*.tsbuildinfo`, `.intenttrace/`, `.cache/`, `coverage/`, `playwright-report/`, and `test-results/`. These paths remain local and must not be committed.

`docs/design/source/` and `docs/design/prototype/` keep historical, non-normative inputs at stable paths. The root `docker-compose.yml` defines the local stack; `infra` keeps the multi-stage Dockerfile and image lock. Real `.env` files, sessions, artifact volumes, and provider keys are never committed.

When a contract changes, update the code, the tests, the generated artifacts, and the corresponding normative document at the same time. Do not copy prototype HTML/CSS into Next; when rebuilding a component, accessibility and real state are authoritative.

## Quality and release process

Local/CI order: frozen install → production dependency audit → format → lint → typecheck → unit → contract → e2e → build → docs → schema drift → Compose config/smoke → migrate twice. A failure must not proceed to the next Gate. Generated artifacts must be regenerated before the checks and leave the working tree free of drift.

The mandatory local gate (same order as CI, after `pnpm install --frozen-lockfile` and `pnpm audit --prod`):

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:e2e
pnpm build
pnpm docs:check
pnpm schema:check
```

Evidence levels are authored-unexecuted, automated-verified, environment-verified, and release-verified. Release-ready may only be declared after the target Linux, the locked Compose images, the health endpoints, backup restore, and the acceptance matrix all pass; a fixture/mock cannot prove a provider or a real user trace.

A release records the schema/migration, image digests, Node/pnpm/lockfile, commit, commands, and known limitations. The first release states explicitly that it is single-host, non-HA, and loopback.
