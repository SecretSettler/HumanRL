---
status: current
owner: maintainers
last_reviewed: 2026-08-10
normative: true
milestone: Gate 0-Gate 5
---

# IntentTrace documentation index

This is the entry point for engineering and product facts. Implementation status is decided only by code, migrations, generated contracts and the evidence-backed [`project/progress.md`](project/progress.md); the historical design package and prototype exist for traceability only and are not test results.

## Route by need

| Need                                  | Entry point                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Start or develop                      | [`development.md`](development.md)                                                                                       |
| Understand architecture and data flow | [`architecture.md`](architecture.md)                                                                                     |
| Change an API or domain contract      | [`contracts.md`](contracts.md), [`contracts/api/`](contracts/api/)                                                       |
| Change persistence or migrations      | [`database.md`](database.md), [`../packages/db/migrations/`](../packages/db/migrations/)                                 |
| Operate, back up, or recover          | [`operations.md`](operations.md), [`operations/`](operations/)                                                           |
| Run quality gates                     | [`testing.md`](testing.md)                                                                                               |
| Check project status and evidence     | [`project/progress.md`](project/progress.md), [`project/readiness.md`](project/readiness.md)                             |
| Run demos and screenshots             | [`../scripts/demo/`](../scripts/demo/)                                                                                   |
| Run checks and maintenance            | [`../scripts/checks/`](../scripts/checks/), [`../scripts/data/`](../scripts/data/), [`../scripts/ops/`](../scripts/ops/) |
| Locate runtime apps                   | [`../apps/`](../apps/)                                                                                                   |
| Locate shared capabilities            | [`../packages/`](../packages/)                                                                                           |

Current normative engineering documents are the topic-based documents and generated contracts indexed below. [`design/source/`](design/source/) and [`design/prototype/`](design/prototype/) are historical, non-normative inputs excluded from implementation evidence; they intentionally remain at these stable paths for provenance and validation.

| Document                                                                                                 | Purpose                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`design/product-spec.md`](design/product-spec.md)                                                       | Product spec and interaction spec (Chinese)                                                               |
| [`architecture.md`](architecture.md)                                                                     | Architecture overview, system invariants, data flow and ordering                                          |
| [`decisions.md`](decisions.md)                                                                           | All 14 ADRs and the ADR index                                                                             |
| [`contracts.md`](contracts.md)                                                                           | Domain model, revision, idempotency, reducer, artifact, adapter, provider and compatibility               |
| [`contracts/api.md`](contracts/api.md)                                                                   | API design, error codes and the SSE protocol                                                              |
| [`contracts/api/openapi.yaml`](contracts/api/openapi.yaml)                                               | Generated OpenAPI; the source of truth for the actual routes                                              |
| [`database.md`](database.md)                                                                             | ERD, schema invariants, migration, and retention/deletion                                                 |
| [`development.md`](development.md)                                                                       | Development environment, contribution flow, repository guide and the quality and release process          |
| [`operations.md`](operations.md)                                                                         | Deployment, observability, backup and restore, and the macOS desktop shell                                |
| [`operations/runbooks.md`](operations/runbooks.md)                                                       | Provider outage, summary job queue, datastore failure, SSE recovery                                       |
| [`security.md`](security.md)                                                                             | Threat model, data handling and the provider egress policy                                                |
| [`testing.md`](testing.md)                                                                               | Test strategy, acceptance fixture/matrix, property tests, semantic evaluation and performance methodology |
| [`reference.md`](reference.md)                                                                           | Configuration reference and glossary                                                                      |
| [`project/plan.md`](project/plan.md)                                                                     | Full build plan, roadmap and milestone definitions (Chinese)                                              |
| [`project/readiness.md`](project/readiness.md)                                                           | Release readiness, risk register and open-source release preparation (Chinese)                            |
| [`project/progress.md`](project/progress.md)                                                             | Append-only progress record with commands, commits and environment evidence (Chinese)                     |
| [`design/source-package.md`](design/source-package.md)                                                   | Original design-package registry and deviation notes (Chinese)                                            |
| [`design/agent-spawn-topology.md`](design/agent-spawn-topology.md)                                       | Agent spawn/join topology design: canonical fields, reducer-derived edges (Chinese)                       |
| [`design/research/agent-spawn-formats.md`](design/research/agent-spawn-formats.md)                       | Measured survey of how six agent harnesses record subagent spawns (Chinese)                               |
| [`design/research/import-experience.md`](design/research/import-experience.md)                           | External research on chat-history import experience (Chinese)                                             |
| [`design/research/slim-runtime-and-queue-removal.md`](design/research/slim-runtime-and-queue-removal.md) | Runtime slimming and queue removal design, a historical record from before that change (Chinese)          |

Entries marked **(Chinese)** are project-internal records and design inputs that are still written in Chinese; every other document above is in English.

Directory layout: the `docs/` root holds the normative documents merged by topic; `docs/contracts/api/` holds the generated OpenAPI; `docs/operations/`, `docs/project/` and `docs/design/` hold the runbook collection, the project records and the design/research documents respectively; `docs/design/source/` and `docs/design/prototype/` are historical inputs and are explicitly excluded from the normative scan; `docs/assets/` holds the README screenshots.

Source-of-truth precedence: Zod/Drizzle/migration → generated JSON Schema/OpenAPI → Accepted ADR → product spec → progress carrying command, commit, environment and artifact evidence. When a lower-precedence document conflicts with a higher-precedence fact, the document must be updated or a new ADR written; choosing silently between them is not allowed. The in-code and off-platform checks required before the repository is made public are in [`project/readiness.md`](project/readiness.md#开源发布准备).
