---
status: accepted
owner: maintainers
last_reviewed: 2026-08-15
normative: false
milestone: repository organization
---

# Repository Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize root scripts by responsibility, clarify repository navigation, and hide disposable local outputs without changing workspace or runtime boundaries.

**Architecture:** Preserve every `apps/*` and `packages/*` workspace and every public pnpm command. Move only root scripts into `checks`, `data`, `demo`, and `ops`; update each moved script's repository-root and package-relative paths; add bilingual navigation and editor visibility settings. Keep historical design paths and generated artifact locations unchanged.

**Tech Stack:** pnpm 11.18.0, Node.js 24.18.1, TypeScript 6.0.3, ESM, Turbo, Prettier, Markdown.

## Global Constraints

- Preserve all `apps/*` and `packages/*` workspace names and boundaries.
- Preserve public root pnpm command names, arguments, environment variables, and behavior.
- Keep Zod schemas, generated JSON Schema/OpenAPI, Drizzle migrations, Docker topology, and runtime data paths unchanged.
- Keep `docs/design/source/` and `docs/design/prototype/` at their current paths; preserve source archive hash and manifest verification.
- Do not leave compatibility aliases or duplicate copies at old root script paths.
- Moved scripts MUST resolve repository-relative imports and resources correctly from their new two-level location.
- Keep `README.md` and `README.zh-CN.md` structurally aligned.
- Historical research records MAY retain old paths when they describe past state; current operational references MUST use the new paths.
- Agents doing concurrent edits MUST NOT run formatters, linters, builds, or tests; the controller runs validation once after integration.
- Final verification MUST run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:contract`, `pnpm test:e2e`, `pnpm build`, `pnpm docs:check`, and `pnpm schema:check`, then record exact evidence in `docs/project/progress.md`.

---

### Task 1: Reorganize Root Scripts

**Files:**

- Move: `scripts/check-docs.mjs` → `scripts/checks/check-docs.mjs`
- Move: `scripts/check-compose.mjs` → `scripts/checks/check-compose.mjs`
- Move: `scripts/performance-smoke.ts` → `scripts/checks/performance-smoke.ts`
- Move: `scripts/rebuild-topology.ts` → `scripts/data/rebuild-topology.ts`
- Move: `scripts/capture-readme-screenshots.mjs` → `scripts/demo/capture-readme-screenshots.mjs`
- Move: `scripts/load-demo.ts` → `scripts/demo/load-demo.ts`
- Move: `scripts/load-demo-synthetic.ts` → `scripts/demo/load-demo-synthetic.ts`
- Move: `scripts/backup.mjs` → `scripts/ops/backup.mjs`
- Move: `scripts/docker-stack.mjs` → `scripts/ops/docker-stack.mjs`
- Move: `scripts/prepare-desktop-stack.mjs` → `scripts/ops/prepare-desktop-stack.mjs`
- Move: `scripts/verify-backup.mjs` → `scripts/ops/verify-backup.mjs`
- Modify: `package.json:22-42`

**Interfaces:**

- Consumes: repository root layout and existing public pnpm script names.
- Produces: `scripts/checks/*`, `scripts/data/*`, `scripts/demo/*`, `scripts/ops/*`; unchanged commands `docs:check`, `docker:*`, `demo:*`, `screenshots:readme`, `desktop:prepare`, `backup*`, `performance:smoke`, and `topology:rebuild`.

- [ ] **Step 1: Verify the target layout does not exist**

Run:

```bash
test ! -e scripts/checks/check-docs.mjs \
  && test ! -e scripts/data/rebuild-topology.ts \
  && test ! -e scripts/demo/load-demo.ts \
  && test ! -e scripts/ops/docker-stack.mjs
```

Expected: exit status `0`; the target paths are absent before the move.

- [ ] **Step 2: Create responsibility directories and move scripts**

Use history-preserving moves for every mapping in **Files**. Do not copy; every old root script path must disappear.

- [ ] **Step 3: Correct moved-script path anchors**

Apply these exact depth changes:

```text
scripts/checks/check-docs.mjs:
  resolve(import.meta.dirname, "..") → resolve(import.meta.dirname, "../..")

scripts/checks/performance-smoke.ts:
  ../packages/... → ../../packages/...

scripts/data/rebuild-topology.ts:
  ../packages/... → ../../packages/...

scripts/demo/load-demo.ts:
  ../packages/... → ../../packages/...

scripts/demo/load-demo-synthetic.ts:
  ../packages/... → ../../packages/...

scripts/ops/docker-stack.mjs:
  resolve(dirname(fileURLToPath(import.meta.url)), "..")
  → resolve(dirname(fileURLToPath(import.meta.url)), "../..")

scripts/ops/prepare-desktop-stack.mjs:
  resolve(import.meta.dirname, "..") → resolve(import.meta.dirname, "../..")
```

`backup.mjs`, `verify-backup.mjs`, `check-compose.mjs`, and `capture-readme-screenshots.mjs` intentionally retain cwd-relative operational behavior because the public pnpm commands run from the repository root.

- [ ] **Step 4: Update desktop archive membership**

In `scripts/ops/prepare-desktop-stack.mjs`, replace the three archived root script paths with:

```js
"scripts/checks/check-docs.mjs",
"scripts/checks/check-compose.mjs",
"scripts/ops/docker-stack.mjs",
```

Do not archive demos, backup scripts, performance smoke, topology maintenance, or implementation-plan files.

- [ ] **Step 5: Update root pnpm command entry points**

Map each `package.json` command to its target path while leaving command names, flags, precommands, and filter expressions unchanged.

- [ ] **Step 6: Controller verification after parallel integration**

Run:

```bash
node scripts/checks/check-docs.mjs
node scripts/checks/check-compose.mjs
pnpm performance:smoke
pnpm desktop:prepare
```

Expected: docs and Compose checks pass; performance smoke emits JSON with `rawEvents: 10000` and `semanticNodes: 1500`; desktop preparation creates `apps/desktop/src-tauri/resources/intenttrace-stack.tar.gz` containing the three new archived script paths.

- [ ] **Step 7: Commit the script migration**

```bash
git add package.json scripts
git commit -m "refactor: organize repository scripts"
```

### Task 2: Add Repository Navigation and Artifact Hiding

**Files:**

- Create: `.vscode/settings.json`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/README.md:9-41`
- Modify: `docs/development.md:40-46`
- Modify: `docs/reference.md:11`

**Interfaces:**

- Consumes: Task 1's exact target directories `scripts/checks/`, `scripts/data/`, `scripts/demo/`, and `scripts/ops/`.
- Produces: bilingual root navigation; authoritative engineering repository map; current docs-check path; VS Code explorer/search exclusions for disposable outputs.

- [ ] **Step 1: Verify current navigation is incomplete**

Confirm that neither root README has a repository-navigation section and `.vscode/settings.json` is absent.

Expected: search for headings `## Repository navigation` and `## 仓库导航` finds no match; editor settings file does not exist.

- [ ] **Step 2: Add aligned root README navigation sections**

Insert a compact section after everyday Docker operations and before the demo section in both root READMEs. Keep headings and row order aligned. Include these destinations:

```text
Start/develop             docs/development.md
Architecture/data flow    docs/architecture.md
API/domain contracts      docs/contracts.md + docs/contracts/api/
Persistence/migrations    docs/database.md + packages/db/migrations/
Operations/recovery       docs/operations.md + docs/operations/
Quality gates             docs/testing.md
Status/evidence           docs/project/progress.md + docs/project/readiness.md
Demos/screenshots         scripts/demo/
Checks/maintenance        scripts/checks/ + scripts/data/ + scripts/ops/
Runtime apps              apps/
Shared capabilities       packages/
```

English prose goes only in `README.md`; Chinese prose goes only in `README.zh-CN.md`.

- [ ] **Step 3: Strengthen the documentation index**

In `docs/README.md`, add a short route-by-need table using the same destinations. Explicitly state that `docs/design/source/` and `docs/design/prototype/` are historical inputs excluded from normative evidence and intentionally remain at stable paths.

- [ ] **Step 4: Expand the engineering repository guide**

In `docs/development.md`, retain the existing app/package dependency explanation and add:

```text
scripts/checks/   static and synthetic checks
scripts/data/     explicit data-maintenance commands
scripts/demo/     demo loading and README screenshot capture
scripts/ops/      Docker, desktop packaging, backup and restore operations
```

Distinguish three artifact classes:

```text
tracked source
committed generated artifacts: JSON Schema, OpenAPI, Drizzle migrations
disposable local output: node_modules, dist, .turbo, .next, *.tsbuildinfo,
  .intenttrace, .cache, coverage, playwright-report, test-results
```

- [ ] **Step 5: Update current operational path references**

Change `docs/reference.md` from `scripts/check-docs.mjs` to `scripts/checks/check-docs.mjs`. Do not rewrite historical research records or the approved migration table in the design spec.

- [ ] **Step 6: Add VS Code visibility settings**

Create `.vscode/settings.json` with identical boolean-true entries under `files.exclude` and `search.exclude` for:

```json
{
  "**/.cache": true,
  "**/.intenttrace": true,
  "**/.next": true,
  "**/.turbo": true,
  "**/*.tsbuildinfo": true,
  "**/coverage": true,
  "**/dist": true,
  "**/node_modules": true,
  "**/playwright-report": true,
  "**/test-results": true
}
```

Do not hide committed generated schema, OpenAPI, migrations, fixtures, archives, or documentation assets.

- [ ] **Step 7: Controller verification after parallel integration**

Run:

```bash
pnpm format:check
pnpm docs:check
```

Expected: Prettier accepts Markdown/JSON and docs link/frontmatter/archive checks pass.

- [ ] **Step 8: Commit navigation changes**

```bash
git add .vscode/settings.json README.md README.zh-CN.md docs/README.md docs/development.md docs/reference.md
git commit -m "docs: clarify repository navigation"
```

### Task 3: Integrate, Verify, and Record Evidence

**Files:**

- Modify: `docs/project/progress.md`
- Verify only: all files changed by Tasks 1-2

**Interfaces:**

- Consumes: completed script and navigation changes.
- Produces: evidence-backed progress entry and a repository state satisfying all mandatory checks.

- [ ] **Step 1: Review integrated paths and references**

Confirm current operational references use the new paths, the eleven old root script files are absent, the eleven new files are present, and historical migration/research records remain intact.

- [ ] **Step 2: Exercise the changed command surface**

Run the safe direct checks and syntactic/argument paths:

```bash
pnpm docs:check
pnpm docker:check
pnpm performance:smoke
pnpm desktop:prepare
pnpm topology:rebuild --
pnpm backup:verify --
```

Expected: the first four commands pass. `topology:rebuild` exits non-zero with its unchanged usage string before connecting to the database. `backup:verify` exits non-zero with its unchanged usage string before touching Docker. Commands that mutate a live stack—demo loading, topology rebuild with real IDs, backup creation/restore, Docker up/down, and screenshot regeneration—must not be run unless an isolated target stack is available; validate their entry paths and unchanged code instead.

Inspect the generated desktop archive:

```bash
tar -tzf apps/desktop/src-tauri/resources/intenttrace-stack.tar.gz
```

Expected: it includes `scripts/checks/check-docs.mjs`, `scripts/checks/check-compose.mjs`, and `scripts/ops/docker-stack.mjs`; it includes none of their old paths.

- [ ] **Step 3: Run the mandatory gate in required order**

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

Record exact pass/fail output. Fix source problems; do not suppress warnings or narrow the gate.

- [ ] **Step 4: Record evidence**

Append a dated entry to `docs/project/progress.md` describing the stable workspace boundaries, script mapping, navigation/editor exclusions, targeted smoke evidence, and every mandatory gate result. Do not claim live stack behaviors not exercised.

- [ ] **Step 5: Re-run documentation and formatting gates**

```bash
pnpm format:check
pnpm docs:check
```

Expected: both pass with the new progress entry.

- [ ] **Step 6: Commit verification evidence**

```bash
git add docs/project/progress.md
git commit -m "docs: record repository organization evidence"
```
