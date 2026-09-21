# Contributing to IntentTrace

IntentTrace welcomes focused bug fixes, documentation improvements, synthetic adapter fixtures, accessibility work, and small, reviewable features.

Before contributing, read:

- [the repository guide](../docs/development.md#repository-guide) for project layout and dependency boundaries;
- [the system invariants](../docs/architecture.md#system-invariants) for raw facts, semantic revisions, and the reducer boundary;
- [the security policy](SECURITY.md) for private vulnerability reporting; and
- [the Code of Conduct](CODE_OF_CONDUCT.md) for community expectations.

## Discuss larger changes first

Open an Issue before starting work on:

- a new trace adapter or model provider;
- a Zod, Drizzle, migration, or OpenAPI contract change;
- retention, deletion, privacy, or security semantics;
- a broad UI or architecture refactor; or
- a new external dependency or license change.

Small bug fixes, tests, and documentation corrections may go directly to a pull request.

## Local setup

You need Node.js `24.18.1`, pnpm `11.18.0`, Corepack, and Docker Compose v2.

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm docker:up
pnpm demo:load
pnpm docker:url
```

See [the development guide](../docs/development.md#getting-started) for environment and repository details.

## Engineering rules

1. Raw execution events are append-only facts. Model output must never overwrite them.
2. Keep user intent, agent intention, observed action, and outcome separate.
3. A model returns proposals only; the deterministic reducer validates and commits them.
4. Semantic graph data must be revisioned and evidence-backed.
5. Raw traces and evidence must remain usable without a summary provider.
6. Never reconstruct, commit, or expose hidden chain-of-thought.
7. Contract changes update schemas, migrations, APIs, fixtures, tests, generated artifacts, and documentation together. Do not edit generated JSON Schema or OpenAPI files by hand.

## Required checks

Run the complete local gate before opening a pull request:

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

Changes involving dependencies, Compose, or migrations also require:

```bash
pnpm audit --prod
pnpm docker:check
pnpm db:migrate
pnpm db:migrate
```

The second migration run proves that the migration is idempotent. If the environment prevents a check, state what was skipped, why, and the remaining risk. Keep authored, automated, environment, and external evidence separate.

## Commits and pull requests

- Keep a branch and commit focused on one reviewable boundary.
- Use a conventional prefix such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, or `chore:`.
- Complete the pull request template, including contract, migration, verification, documentation, and residual-risk sections.
- Treat screenshots as UI evidence only; they do not prove backend behavior.
- Explain license, migration, and release-artifact effects for dependency upgrades.

All commits must include the [Developer Certificate of Origin 1.1](https://developercertificate.org/) sign-off:

```text
Signed-off-by: Your Name <your.email@example.com>
```

Use `git commit -s` to add it. Unless stated otherwise, accepted contributions are licensed under `AGPL-3.0-only`.

## Data and privacy

Commit only synthetic or irreversibly anonymized fixtures. Never put the following in Git, an Issue, a pull request, CI output, or a screenshot:

- provider or API keys, cookies, authorization headers, or `.env` files;
- real Codex or Claude sessions, complete terminal logs, or database dumps;
- trace payloads, private source, private paths, or native session identifiers; or
- hidden reasoning, internal snapshots, or full prompt and response bodies.

When real data is required for local validation, publish only de-identified counts and outcomes. Follow the [data-handling policy](../docs/security.md#data-handling).
