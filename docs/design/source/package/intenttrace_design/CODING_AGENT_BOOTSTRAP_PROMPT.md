# IntentTrace MVP — Coding Agent Bootstrap Prompt

Build the MVP of **IntentTrace** from `IntentTrace_Design_Document.md` and use `intenttrace_ui_prototype.html` as the visual target.

## Non-negotiable product rules

- Raw execution events are immutable facts.
- The semantic intent graph is derived, versioned, and evidence-backed.
- The system must distinguish user intent, agent intention, observed action, and outcome.
- An LLM never writes directly to storage. It returns an `IntentGraphPatch`; a deterministic reducer validates and commits it.
- The raw trace, timeline, and evidence inspector must remain usable when every summary provider is unavailable.
- Do not reconstruct or expose hidden chain-of-thought.

## Implementation constraints

1. Use a pnpm TypeScript monorepo with `apps/web`, `apps/api`, `apps/worker`, `packages/schema`, `packages/adapters`, `packages/summarizer`, and `packages/ui`.
2. Use Next.js, React Flow, ELK.js, Tailwind CSS, shadcn/ui, Zustand, and TanStack Query for the web app.
3. Use Fastify, Zod, Drizzle, PostgreSQL, Redis/BullMQ, and MinIO for backend services.
4. Use SSE for server-to-client live updates in the MVP.
5. Implement a deterministic mock summary provider before any real API provider.
6. Implement raw trace ingestion, graph rendering, Gantt rendering, and evidence drill-down before LLM summarization.
7. Do not add a graph database, ClickHouse, Temporal, embeddings, authentication, multi-tenancy, or Kubernetes in the MVP.
8. Do not send source-code bodies, full documents, or complete terminal logs to a cloud model by default. Send a deterministic event sketch.
9. Validate all provider output against `contracts/intent-graph-patch.schema.json` and enforce evidence-ID allowlists.
10. Add fixture-based tests for every adapter and reducer rule.

## Milestone 1 — runnable product shell

- Create the monorepo and Docker Compose stack.
- Define shared Zod schemas for `RawTraceEvent`, `SemanticNode`, `SemanticEdge`, `UserIntent`, and `IntentGraphPatch`.
- Add a mock trace generator with six agents, parallel work, one failure, one repair, one handoff, and one final merge.
- Render a stable Git-like intent graph synchronized with an Agent Gantt timeline.
- Clicking a semantic node opens an evidence inspector containing raw events, artifacts, confidence, provenance, and revision metadata.
- Add replay, pause, seek, Live/Final revision switching, semantic zoom, and reduced-motion support.

## Milestone 2 — semantic pipeline

- Build deterministic normalization and event-sketch generation.
- Implement rule-based semantic chunk boundaries.
- Add a mock provider that emits valid graph patches.
- Implement a reducer for schema validation, evidence validation, status-transition validation, cycle detection, deduplication, pin protection, and revision persistence.
- Show a ghost node while a chunk summary is pending, then animate the validated patch into the graph without relaying out unaffected branches.

## Milestone 3 — provider adapters

- Add an OpenAI-compatible provider interface.
- Add DeepSeek and OpenAI adapters with strict structured output.
- Add timeout, retry, cache, budget, and fallback behavior.
- Add provider-level cost accounting by trace, chunk, node, model, and prompt version.
- Preserve the complete mock path as an offline demo.

## Required acceptance fixture

The fixture must contain at least 2,000 raw events and demonstrate this narrative:

1. User asks for an evidence-backed multi-agent trace viewer.
2. Orchestrator decomposes the task into research, backend, frontend, summarization, and testing.
3. Agents run in parallel.
4. Backend imports a malformed `trace_id` and tests fail.
5. The failure becomes an `issue` semantic node.
6. Backend normalizes IDs and reruns tests.
7. The repair connects through `resolved_by`.
8. Orchestrator joins branches and creates a final result.

## Definition of done for every milestone

Run and pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

Then update `docs/progress.md` with completed work, deliberate deviations, screenshots, test results, and unresolved issues. Do not begin the next milestone while the current acceptance tests fail.
