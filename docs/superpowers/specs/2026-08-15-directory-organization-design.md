---
status: proposed
owner: maintainers
last_reviewed: 2026-08-15
normative: false
milestone: repository organization
---

# Repository organization design

## Problem

IntentTrace has a sound high-level monorepo boundary, but the repository is difficult to scan in three places:

1. Local build and runtime artifacts are present below many workspaces: `.turbo/`, `dist/`, `node_modules/`, `*.tsbuildinfo`, `.next/`, `.intenttrace/`, and test reports. They are ignored by Git, but still add noise to file-tree views.
2. The root `scripts/` directory mixes checks, demos, data maintenance, Docker lifecycle, backups, and desktop preparation.
3. `docs/` intentionally contains several document lifecycles—normative engineering documents, project evidence, design inputs, research, and prototypes—but the distinction is not obvious from the first directory listing.

The current `apps/` and `packages/` boundaries are not the primary source of the problem. Their dependency direction is already documented and should not be destabilized as part of this cleanup.

## Goals

- Make the repository's first-level navigation self-explanatory.
- Group root scripts by operational responsibility without changing their behavior.
- Make historical design inputs visibly archival while preserving their provenance and validated paths.
- Reduce local artifact noise where practical without moving generated outputs into source directories or changing build semantics.
- Preserve stable package names, workspace membership, generated artifact ownership, database migration paths, and runtime topology.
- Leave a clear migration map so every moved script and documentation link can be updated in one change.

## Non-goals

- Do not merge, rename, or otherwise redesign the `apps/*` or `packages/*` workspaces.
- Do not introduce a root orchestration abstraction or replace the existing pnpm/Turbo commands.
- Do not delete historical source packages, prototypes, research, or design archives.
- Do not move generated JSON Schema, OpenAPI, or Drizzle migration artifacts away from their current source-of-truth locations.
- Do not change Docker service topology, loopback exposure, persistence, API behavior, or runtime data paths.
- Do not add cloud storage, a new artifact manager, or a repository-wide output directory solely to make the tree look shorter.

## Target layout

The target keeps the current application and package layout and adds responsibility-based subdivisions only under root `scripts/`:

```text
apps/                         deployable runtime units
  api/
  collector/
  desktop/
  web/
  worker/

packages/                     reusable libraries and domain capabilities
  adapters/
  config/
  db/
  graph-layout/
  ingest/
  intent-reducer/
  schema/
  storage/
  summarizer/
  test-fixtures/
  ui/

tests/                        cross-workspace end-to-end tests

scripts/
  checks/
    check-compose.mjs
    check-docs.mjs
    performance-smoke.ts
  data/
    rebuild-topology.ts
  demo/
    capture-readme-screenshots.mjs
    load-demo.ts
    load-demo-synthetic.ts
  ops/
    backup.mjs
    docker-stack.mjs
    prepare-desktop-stack.mjs
    verify-backup.mjs

docs/
  README.md                   documentation index
  architecture.md             normative architecture
  contracts.md
  database.md
  decisions.md
  development.md
  operations.md
  reference.md
  security.md
  testing.md
  contracts/
  operations/
  project/
  design/
    product-spec.md
    agent-spawn-topology.md
    research/
    source/                  preserved historical source package
    prototype/               preserved historical prototypes

infra/                        image and deployment assets
docker-compose.yml
```

The directory names describe use, not implementation layers. The existing `packages/` dependency order remains the authority for code boundaries.

## Migration mapping

| Current path                             | Target path                                   | Change required                                                                                                |
| ---------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `scripts/check-docs.mjs`                 | `scripts/checks/check-docs.mjs`               | Update root `docs:check`; update any direct references.                                                        |
| `scripts/check-compose.mjs`              | `scripts/checks/check-compose.mjs`            | Update root `docker:check`; update any direct references.                                                      |
| `scripts/performance-smoke.ts`           | `scripts/checks/performance-smoke.ts`         | Update root `performance:smoke`.                                                                               |
| `scripts/rebuild-topology.ts`            | `scripts/data/rebuild-topology.ts`            | Update root `topology:rebuild`.                                                                                |
| `scripts/capture-readme-screenshots.mjs` | `scripts/demo/capture-readme-screenshots.mjs` | Update root `screenshots:readme`; preserve output behavior.                                                    |
| `scripts/load-demo.ts`                   | `scripts/demo/load-demo.ts`                   | Update root `demo:load`.                                                                                       |
| `scripts/load-demo-synthetic.ts`         | `scripts/demo/load-demo-synthetic.ts`         | Update root `demo:load:synthetic`.                                                                             |
| `scripts/backup.mjs`                     | `scripts/ops/backup.mjs`                      | Update root `backup`; preserve arguments and destination semantics.                                            |
| `scripts/docker-stack.mjs`               | `scripts/ops/docker-stack.mjs`                | Update `docker:*` commands; audit path resolution because the script currently resolves from its own location. |
| `scripts/prepare-desktop-stack.mjs`      | `scripts/ops/prepare-desktop-stack.mjs`       | Update root `desktop:prepare`; preserve archive generation path.                                               |
| `scripts/verify-backup.mjs`              | `scripts/ops/verify-backup.mjs`               | Update root `backup:verify`; preserve restore verification behavior.                                           |

`apps/api/scripts/`, `apps/desktop/scripts/`, `packages/schema/scripts/`, and `packages/test-fixtures/scripts/` remain package-local. They are coupled to one workspace and should not be mixed with root operational scripts.

## Documentation navigation

`docs/README.md` remains the documentation index. The implementation should add a short “Find your way around” section to the root `README.md` and a matching repository map to `docs/development.md`:

| Need                                | Entry point                                             |
| ----------------------------------- | ------------------------------------------------------- |
| Start the local stack               | `docs/development.md`                                   |
| Understand boundaries and data flow | `docs/architecture.md`                                  |
| Change an API or domain contract    | `docs/contracts.md`, `docs/contracts/api/`              |
| Change persistence or migrations    | `docs/database.md`, `packages/db/migrations/`           |
| Operate, back up, or recover        | `docs/operations.md`, `docs/operations/`                |
| Run quality gates                   | `docs/testing.md`                                       |
| Check project status and evidence   | `docs/project/progress.md`, `docs/project/readiness.md` |
| Run demos and screenshots           | `scripts/demo/`                                         |
| Run checks and maintenance          | `scripts/checks/`, `scripts/data/`, `scripts/ops/`      |

The documentation index should explicitly state that `docs/design/source/` and `docs/design/prototype/` are historical inputs, not current implementation evidence. They must remain at their current paths in this first reorganization because `scripts/check-docs.mjs` excludes those exact directories from the normative scan and validates the source archive hash and manifest there. Renaming them requires a separate migration with corresponding checker changes and hash/path verification.

## Local artifact visibility

Keep output locations unchanged. The repository already ignores the known generated and local-state paths, including workspace-local `dist/`, `.turbo/`, `.next/`, `*.tsbuildinfo`, `node_modules/`, `.intenttrace/`, coverage, Playwright reports, and test results. The implementation should add a committed `.vscode/settings.json` only if the repository's editor policy accepts VS Code workspace settings; if it does, configure the explorer and search to exclude those paths. This is an optional editor convenience, not a build or source-layout requirement.

The non-optional part is documentation: `docs/development.md` should distinguish tracked source, committed generated artifacts, and disposable local output. No ignored local state may be added to Git merely to centralize the view.

## Invariants and safety constraints

- Raw execution events remain append-only facts; this cleanup must not touch runtime data or persistence code.
- Zod schemas remain the domain authoring source; generated JSON Schema and OpenAPI remain generated and must be regenerated, never hand-edited.
- Drizzle migrations remain under `packages/db/migrations/`.
- Every root package script continues to invoke the same underlying command with the same arguments and environment assumptions.
- Relative paths in moved scripts must be anchored to the repository root or computed from the script module location, not accidentally made dependent on the caller's current directory.
- Every moved path must have all tracked callsites updated, including README, docs, CI, package scripts, and shell snippets.
- The historical design archive's SHA-256 and manifest checks must continue to pass.
- The reorganization must produce no runtime compatibility aliases or duplicate script copies.

## Verification plan

After implementation, run the required repository gate from `AGENTS.md`: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:contract`, `pnpm test:e2e`, `pnpm build`, `pnpm docs:check`, and `pnpm schema:check`.

The directory-specific checks must also demonstrate:

1. Each changed root package script executes the moved file through its existing public command name.
2. `pnpm docs:check` resolves all updated links and still accepts the historical source archive and manifest.
3. `pnpm topology:rebuild`, demo loading, backup/verification, Docker lifecycle checks, desktop preparation, screenshot capture, and performance smoke retain their prior path and argument behavior.
4. The final tracked tree contains no duplicate old script paths and no generated-artifact relocation.
5. `git diff --check` reports no whitespace errors.

## Rollback

The migration is a single path-and-navigation change. Revert the commit to restore the original script paths and documentation text. Because workspace package names, generated artifact locations, database migrations, and runtime topology are unchanged, rollback does not require a data migration or deployment compatibility window.

## Implementation order

1. Add the new script directories and move root scripts with `git mv`.
2. Update `package.json`, script-local path assumptions, CI, README, and documentation references.
3. Add the repository map and historical-design explanation to the documentation entry points.
4. Decide whether to commit the optional VS Code visibility settings; do not make this a prerequisite for the source reorganization.
5. Run the directory-specific smoke checks, then the mandatory repository quality gate.
6. Record the commands and results in `docs/project/progress.md`.
