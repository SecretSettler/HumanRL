---
status: accepted
owner: maintainers
last_reviewed: 2026-08-10
normative: true
milestone: Gate 0-Gate 5
---

# Contracts

This document is the collection of the seven contract categories: data, idempotency, reducer, artifact, adapter, provider, and compatibility. API-level routes, error codes, and the stream protocol live separately in [`contracts/api.md`](contracts/api.md), and the generated OpenAPI is in [`contracts/api/openapi.yaml`](contracts/api/openapi.yaml).

## Domain model

`RawTraceEvent` is an envelope versioned by `schemaVersion`: server event ID, workspace/project/trace, source kind/session/event ID, adapter name/version, source time, server `ingestSeq`, agent/span/parent lineage, event kind, status, payload hash/ref, artifact refs. The database MUST NOT inline the full raw payload.

The EIG's `SemanticNode` is divided into `request|goal|work|decision|issue|handoff|result`, with status `proposed|active|blocked|completed|abandoned|superseded`; the officially committed graph does not accept a provider's proposed visible status. Every node version has intent/action/outcome claims, and each of them references evidence separately. An edge has its own logical/version ID, direction, kind, and evidence.

`suggestedConfidence` exists only in the provider patch; the `confidence` of a canonical claim is the `high|medium|low` that the reducer derives from the evidence rules. `stated|inferred|mixed` expresses provenance, not probability.

## Revision model

A revision is an immutable set of graph-snapshot references; it does not copy unchanged entities. Its fields include at least revision ID, trace ID, parent revision ID, branch kind, event watermark, status, stale reason, created at/source job. Node/edge membership points at immutable versions; logical IDs are stable across versions. Late-arriving facts do not rewrite graph content or membership; the database allows a revision's `stale` metadata a single one-way `false → true` transition only, and any reverse transition, or any simultaneous modification of other fields, is rejected by a trigger.

A `live` revision MAY grow with verified chunks; a `final` revision is produced only after the complete marker and reconciliation; a `human` revision branches from a chosen parent and stores pins/edits. When a late event is above the final watermark, the old final is retained but marked stale, and a new final is produced afterwards. Concurrent reducers MUST compare-and-commit on `baseRevisionId`; a stale base returns a conflict and is re-queued, and cannot be overwritten automatically.

A replay query MUST be given both the trace and a watermark/revision; it cannot backfill a historical point in time from current membership.

## Event ordering and idempotency

Source time MAY be missing, duplicated, or move backwards, and is used for display only. The canonical processing order is the server-assigned `ingestSeq` within a trace; the assignment happens in the same transaction as the raw insert, and cannot be delegated to Redis or an in-process counter.

The idempotency identity is source kind + source session ID + source event ID. The payload SHA-256 is computed after canonical normalization: the first write is assigned a server ID/sequence; a repeated identity with the same hash returns the original record marked `duplicate`; a repeated identity with a different hash returns HTTP 409 with code `integrity_conflict`, and neither copy is overwritten.

start/end/correction/complete/late are all append events. Out-of-order arrival is acceptable; a malformed ID fails visibly at the adapter boundary, and only a repair that the specification explicitly permits MAY produce new normalized fields, while retaining the original payload ref.

## Reducer contract

A patch MUST contain `schemaVersion`, `jobNonce`, `baseRevisionId`, ordered operations, and unresolved questions. New entities use a `tmp:<n>` reference that is unique within this patch; every other ID MUST belong to the base revision or the allowlist. Operations are the explicit `add_node|update_node|suggest_merge`; generic JSON Patch is not accepted. A provider proposes node semantics only — `kind`, `title` and `claims`. It cannot propose an edge, a parent, a status, an agent or an artifact, and `suggest_merge` is advisory: it reaches the caller as a reducer diagnostic and creates neither node nor edge.

The reducer runs in a fixed order: schema/size → nonce/base/input hash → evidence allowlist → node operations → deterministic topology derivation → canonical sort/hash → transaction commit. Any failure rejects the entire patch.

Structural edges and `primaryParentId` are derived, never proposed. `deriveTopology` reads canonical topology facts ordered by server `ingestSeq` and emits only `decomposes_to`, `hands_off_to`, `produces`, `depends_on` and `blocks`; the remaining members of `SemanticEdgeKindSchema` are reserved names that no derivation rule emits. A derived edge carries the raw events it was derived from plus `stated` or `inferred` provenance, and an edge whose endpoints are absent, identical or whose source declares the relationship `unsupported` is omitted rather than guessed. Logical edge identity is `traceId + kind + source + target`, so it is stable across provider operation order and job nonces. Human-pinned title/parent/status/claim take precedence over the provider, and a pinned node is never re-derived. Re-submitting the same patch returns the existing revision.

Evidence rules: every add/update of a node requires at least one permitted event, and every newly written edge requires a non-empty evidence set; completion/result MUST contain outcome evidence; only an explicitly passing test, a created artifact, a successful command, or a direct result MAY reach high. A model suggestion can at most lower review priority; it cannot raise the final level. Pre-upgrade edge rows that carry no evidence are omitted from reads rather than being backfilled.

## Artifact and evidence contract

Artifacts are content-addressed by `(traceId, sha256)`, and their metadata records byte length, media type, creation time, and an optional redaction state. `put` MUST compute the hash first and land the bytes on disk atomically; `stat` does not return content; `getRange` reads only an explicit range; `deleteTrace` deletes that trace's namespace. Paths cannot be assembled from user input.

Evidence is the relationship from a claim to a raw event/artifact, recording the evidence kind and an optional range. Intent, action, and outcome each establish their own claim; a single "node confidence" cannot be used to mask differences in evidence. Summaries the UI displays are escaped by default; source code, terminal output, and HTML are all handled as untrusted content, and download and inline rendering have separate media policies.

Deleting a trace first blocks new writes, then deletes the database membership/evidence/metadata and the artifact namespace, and finally writes a local audit result; deletion inside backups follows the retention document, and immediate physical erasure is not promised.

## Adapter contract

An adapter declares source kind/version, supported source versions, topology capability, and whether input is a single file or bundle. Implemented imports are canonical JSONL, OTLP HTTP JSON, Codex, Claude, OpenCode, OMP, and Grok; Pi is canonical-event-only and has no transcript parser. Topology facts use `parentAgentId`, `spawnedAgentIds`, `joinedAgentIds`, `joinedBy`, `senderAgentId`, `recipientAgentId`, `messageId`, `onBehalfOf`, `assignedBy`, and `topologyProvenance` (`stated` or `inferred`).

Codex and Claude adapters are version `3.0.0`; OpenCode, OMP, and Grok are `1.0.0`. Codex bundle parsing follows session metadata and parent thread IDs, Claude bundles pair root transcripts with sidecars, OpenCode reads SQLite/WAL, OMP groups same-stem session files, and Grok reads vendor `_x.ai/session/update` records. Each parser drops hidden reasoning/signatures, encrypted content and host paths before artifacts are emitted. Reducer-owned structural edges are derived only from these canonical topology facts; adapters do not choose graph parents or semantic edges.

`prepareSessionParts` accepts normalized POSIX-relative byte parts, rejects unsafe paths, preflights all logical traces and keeps artifact keys adapter-local until API registration. Missing bundle companions fail closed; the shared browser/Collector frame is `application/vnd.intenttrace.session-bundle`.

## Summarizer provider contract

The provider receives a deterministic event sketch, root intent, active nodes, candidate parents, allowlisted event/artifact/agent IDs, locale, prompt version, job nonce, and base revision. Source code bodies, complete documents, complete terminal logs, and secrets are not sent by default; chunk input is canonically hashed first so that it can be cached and audited.

The sketch of each summary job contains only the deterministic chunk in `(previous job watermark, current watermark]`, and cannot repeatedly send the entire trace prefix. A sketch carries at least the event ID, kind, status, agent, readable bounded name, content type, and that event's allowlisted artifact IDs. The permanent mock provider MUST prefer content events such as errors, user/assistant messages, and tool results/calls, so that telemetry such as token counts, mode, and context does not occupy semantic nodes; the final marker MAY serve as completion evidence, but "Offline import complete" cannot be used in place of the actual outcome content.

The output can only be a provider patch, which is then fully validated locally by Zod and the reducer. The mock provider is permanently available and needs no network. A real provider is optional only after the Gate 4 egress gate is opened; the registry records the provider, model/snapshot, capabilities, price date, and prompt version, and business logic does not hard-code prices or a "latest model".

Timeouts, 429s, budget exhaustion, bad JSON, and schema/reducer rejections all produce a structured provider call result and fall back to raw-only; there is no cross-provider fallback by default. Keys, Authorization headers, and un-redacted prompts MUST NOT be logged.

## Compatibility policy

The envelope, patch, checkpoint, SSE, and public API all carry explicit versions. Adding an optional field stays within the same minor; changing semantics, changing required fields, or removing an enum member requires a new major plus a migration/adapter. A reader MUST reject an unknown major; unknown minor fields MAY be ignored where the schema allows it, while retaining the original payload ref.

All dependencies are exact versions, and CI installs the lockfile frozen. The root-level `pnpm-workspace.yaml` overrides are also an audited dependency contract; they currently pin Next's transitive dependencies to `postcss 8.5.25` and `sharp 0.35.0`, to fix the known vulnerabilities that the 2026-08-03 audit hit. Upgrades are committed separately, and MUST pass typecheck, production audit, migration on an empty database and on a repeated run, schema drift, fixtures, licensing, and the Compose smoke test. Generated JSON Schema/OpenAPI are committed artifacts; CI fails when the source and the generated artifacts disagree.

The first release supports Linux x86_64. The Node collector uses portable APIs, but no official support claim is made for macOS/Windows until fixture and follow/rotation verification is complete.
