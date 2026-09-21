---
status: accepted
owner: api
last_reviewed: 2026-08-10
normative: true
milestone: Gate 0-Gate 5
---

# API contract

This document covers REST/OTLP route conventions, Problem Details error codes, and the durable SSE protocol. The routes that actually exist are always governed by the generated [`api/openapi.yaml`](api/openapi.yaml); this document only describes the rules the generated artifact cannot express.

## API design

The actual routes are governed by the generated [`openapi.yaml`](api/openapi.yaml). Besides health/readiness/version/metrics, the implemented routes are event ingest, trace list/detail/delete, raw pagination, snapshot, graph revision, revision list (`GET /api/v1/traces/{traceId}/revisions`, in reverse creation-time order, so that the Live/Final switch can locate a revision), human node edit, provider-call audit, artifact range, SSE, browser session import (`POST /api/v1/imports/candidates` and `POST /api/v1/imports/sessions`), and the standard OTLP JSON receiver. `/documentation` is the local OpenAPI UI and does not count as a business API.

Business REST is uniformly under `/api/v1`; the OTLP receiver independently uses `POST /v1/traces` and returns partial success. A source identity collision returns `409 integrity_conflict`; deletion requires `confirm` to be exactly equal to the trace ID; a human edit MUST carry the current `baseRevisionId`. Pagination and SSE use a monotonic cursor; source time cannot be used to stand for "what was known at the time".

The API only accesses the database/ArtifactStore and never reads arbitrary host paths. Both `imports/*` routes parse only explicitly uploaded bytes. Browser metadata inspection uses candidate protocol v2: `{ protocolVersion: 2, includePreviews, parts[] }`, with at most 5,000 metadata parts, 50 logical candidate roots plus reachable companions, 64 KiB per text head, and 4 MiB aggregate decoded heads. Candidate rows expose deterministic opaque `candidateId` and `partRefs`; an incomplete text head is truncated to its last complete newline. OpenCode inspection instead uses complete framed DB/WAL bytes and fails closed for JSON heads.

Full inspection/import uses `application/vnd.intenttrace.session-bundle`: `ITB1`, a big-endian u32 manifest length (maximum 1 MiB), strict UTF-8 JSON, then concatenated payload. Manifest part order must equal strictly increasing offset order; positive-length, unique-clientRef ranges exactly cover the payload. Inspection requires `candidateIds=[]`; import requires one to 50 IDs and returns protocol-v2 batch results. The configured aggregate request cap is 64 MiB. The API uses `prepareSessionParts`, completes preflight for every selected candidate before writes, then registers referenced artifacts and ingests each logical trace in deterministic event order.

Topology declarations are exposed in snapshots as `topology.declared` and observed counts (`lanes`, `lanesWithParent`, `spawnEdges`, `peerEdges`). Graph structural edges are reducer-derived and include audited evidence event IDs plus provenance; adapter source mappings never authorize ingest-order edges.

## API errors

JSON errors use the Problem Details fields: `type`, `title`, HTTP `status`, a stable `code`, and `requestId`, and MAY add a secret-free `detail`/field errors. Clients branch on `code` and do not parse the title.

Reserved codes: `validation_failed` 400, `unsupported_source_version` 422, `unknown_source_format` 422, `no_visible_events` 422, `preflight_failed` 422, `integrity_conflict` 409, `revision_conflict` 409, `cursor_expired` 410, `payload_too_large` 413, `unsupported_media_type` 415, `provider_unavailable` 503. Unknown errors are uniformly `internal_error` 500; the log contains the internal cause, and the response contains no stack, SQL, path, or key.

`payload_too_large` 413 and `unsupported_media_type` 415 are emitted at the framed upload boundary. Invalid JSON metadata returns `400 validation_failed`; malformed frames return `400 invalid_session_bundle`; stale or missing recomputed candidate IDs return `409 stale_session` before any candidate in the frame is inserted. `unknown_source_format` means no implemented adapter recognizes the supplied explicit bytes.

OTLP partial-success follows OTLP response semantics rather than generic Problem Details; the corresponding HTTP error is used only when the entire HTTP envelope cannot be decoded.

## SSE protocol

_The source document's status is `draft`: the event families and fields may still change, and it is not yet accepted._

Every frame contains a durable decimal outbox `id`, a versioned `event` name, and JSON data. A connection first obtains a cursor from a REST snapshot, then resumes with `Last-Event-ID` or `?cursor=`; when both are supplied and disagree, the request is rejected.

The event families are planned as `raw_event.appended`, `trace.completed`, `semantic_chunk.pending`, `revision.committed`, `revision.stale`. `semantic_chunk.pending` contains only deterministic chunk/job metadata; unverified model nodes are never exposed through the stream. Clients deduplicate monotonically by ID, and after detecting a gap they stop applying and request re-delivery.

An old cursor past outbox retention returns `410 cursor_expired`, and the client clears its temporary state and fetches a new snapshot. Heartbeat comments do not consume an outbox ID. The SSE payload contains only refs/summaries and does not inline large artifacts.
