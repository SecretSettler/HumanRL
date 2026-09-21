import { randomUUID } from "node:crypto";

import { payloadHash } from "@intenttrace/ingest";
import {
  deriveTopology,
  topologyCapabilityKey,
  type ReducerGraphState,
  type ReducerRawFact,
} from "@intenttrace/intent-reducer";
import {
  RawTraceEventInputSchema,
  UuidSchema,
  type HumanNodeEdit,
  type IngestResult,
  type Provenance,
  type RawTraceEvent,
  type RawTraceEventInput,
  type SemanticGraphSnapshot,
  type SemanticRevision,
  type TopologyCapability,
  type TraceSourceKind,
  type TraceSummary,
  type TraceTopology,
} from "@intenttrace/schema";

import type postgres from "postgres";

export class IntegrityConflictError extends Error {
  readonly code = "integrity_conflict";
  readonly statusCode = 409;

  constructor(readonly existingEventId: string) {
    super("source event identity already exists with different content");
    this.name = "IntegrityConflictError";
  }
}

export class RepositoryNotFoundError extends Error {
  readonly code = "not_found";
  readonly statusCode = 404;

  constructor(resource: string) {
    super(`${resource} was not found`);
    this.name = "RepositoryNotFoundError";
  }
}

export class StaleSummaryJobError extends Error {
  readonly code = "stale_revision";

  constructor() {
    super("summary job base revision is no longer current");
    this.name = "StaleSummaryJobError";
  }
}

type Sql = postgres.Sql;
type TransactionSql = postgres.TransactionSql;
interface AgentTimelineLane {
  agentId: string;
  displayName: string;
  eventIds: string[];
  startedAt: string;
  endedAt: string;
  errorCount: number;
}

interface RawEventRow {
  id: string;
  trace_id: string;
  ingest_seq: string | bigint;
  source_kind: RawTraceEvent["source"]["kind"];
  source_format_version: string;
  adapter_version: string;
  source_instance_id: string;
  source_event_id: string;
  event_hash: string;
  occurred_at: Date;
  ingested_at: Date;
  kind: RawTraceEvent["kind"];
  name: string;
  status: RawTraceEvent["status"];
  subject_id: string | null;
  causation_event_id: string | null;
  agent_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  payload_sha256: string | null;
  payload_ref: string | null;
  payload_byte_length: string | bigint | null;
  artifact_refs: string[];
  attributes: Record<string, unknown>;
  workspace_id: string;
  project_id: string;
}

interface TraceRow {
  id: string;
  project_id: string;
  title: string;
  status: TraceSummary["status"];
  event_count: string | bigint;
  latest_ingest_seq: string | bigint;
  latest_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRawEvent(row: RawEventRow): RawTraceEvent {
  return {
    schemaVersion: "1.0.0",
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    traceId: row.trace_id,
    source: {
      kind: row.source_kind,
      formatVersion: row.source_format_version,
      adapterVersion: row.adapter_version,
      sourceInstanceId: row.source_instance_id,
      sourceEventId: row.source_event_id,
    },
    ingestSeq: String(row.ingest_seq),
    occurredAt: toIso(row.occurred_at),
    ingestedAt: toIso(row.ingested_at),
    kind: row.kind,
    name: row.name,
    status: row.status,
    ...(row.subject_id ? { subjectId: row.subject_id } : {}),
    ...(row.causation_event_id ? { causationEventId: row.causation_event_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.span_id ? { spanId: row.span_id } : {}),
    ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
    ...(row.payload_sha256 && row.payload_ref && row.payload_byte_length !== null
      ? {
          payloadRef: {
            artifactId: row.payload_ref,
            sha256: row.payload_sha256,
            byteLength: Number(row.payload_byte_length),
          },
        }
      : {}),
    artifactRefs: row.artifact_refs ?? [],
    attributes: row.attributes ?? {},
  };
}

function mapTrace(row: TraceRow): TraceSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    eventCount: String(row.event_count),
    latestIngestSeq: String(row.latest_ingest_seq),
    latestRevisionId: row.latest_revision_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function eventHashInput(input: RawTraceEventInput): unknown {
  const event = { ...input };
  delete event.workspaceName;
  delete event.projectName;
  delete event.traceTitle;
  return event;
}

type IngestWarning = IngestResult["warnings"][number];

function causationWarnings(attributes: Record<string, unknown>): IngestWarning[] {
  const value = attributes.intenttraceWarnings;
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const warning = candidate as Record<string, unknown>;
    if (warning.code !== "causation_source_event_unresolved") return [];
    return typeof warning.sourceEventId === "string"
      ? [{ code: warning.code, sourceEventId: warning.sourceEventId }]
      : [{ code: warning.code }];
  });
}

function mapReducerRawFact(row: RawEventRow): ReducerRawFact {
  const attributes = row.attributes ?? {};
  const stringAttribute = (key: string): string | undefined =>
    typeof attributes[key] === "string" ? attributes[key] : undefined;
  const stringArrayAttribute = (key: string): string[] | undefined => {
    const value = attributes[key];
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? [...value]
      : undefined;
  };
  const parentAgentId = stringAttribute("parentAgentId");
  const spawnedAgentIds = stringArrayAttribute("spawnedAgentIds");
  const joinedAgentIds = stringArrayAttribute("joinedAgentIds");
  const joinedBy = stringAttribute("joinedBy");
  const senderAgentId = stringAttribute("senderAgentId");
  const recipientAgentId = stringAttribute("recipientAgentId");
  const messageId = stringAttribute("messageId");
  const onBehalfOf = stringAttribute("onBehalfOf");
  const assignedBy = stringAttribute("assignedBy");
  const topologyProvenance = stringAttribute("topologyProvenance");
  return {
    eventId: row.id,
    sourceKind: row.source_kind,
    adapterVersion: row.adapter_version,
    sourceEventId: row.source_event_id,
    ingestSeq: String(row.ingest_seq),
    kind: row.kind,
    status: row.status,
    agentId: row.agent_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    causationEventId: row.causation_event_id,
    artifactRefs: [
      ...new Set([...(row.payload_ref ? [row.payload_ref] : []), ...(row.artifact_refs ?? [])]),
    ],
    ...(parentAgentId ? { parentAgentId } : {}),
    ...(spawnedAgentIds ? { spawnedAgentIds } : {}),
    ...(joinedAgentIds ? { joinedAgentIds } : {}),
    ...(joinedBy ? { joinedBy } : {}),
    ...(senderAgentId ? { senderAgentId } : {}),
    ...(recipientAgentId ? { recipientAgentId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(onBehalfOf ? { onBehalfOf } : {}),
    ...(assignedBy ? { assignedBy } : {}),
    ...(topologyProvenance === "stated" || topologyProvenance === "inferred"
      ? { topologyProvenance }
      : {}),
  };
}

function assertAuditedEdges(state: ReducerGraphState): void {
  for (const edge of state.edges) {
    const validEvidence =
      edge.evidenceEventIds.length > 0 &&
      edge.evidenceEventIds.length <= 64 &&
      edge.evidenceEventIds.every((eventId) => UuidSchema.safeParse(eventId).success);
    if (
      !validEvidence ||
      (edge.provenance !== "stated" &&
        edge.provenance !== "inferred" &&
        edge.provenance !== "mixed")
    ) {
      throw new Error("semantic edge audit metadata is invalid");
    }
  }
}

export interface StreamEventRecord {
  id: string;
  traceId: string;
  revisionId: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface ArtifactRecord {
  id: string;
  traceId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  storageKey: string;
  redacted: boolean;
}

export interface ProviderCallAudit {
  id: string;
  summaryJobId: string;
  provider: string;
  model: string;
  status: string;
  inputTokens: string | null;
  outputTokens: string | null;
  costUsd: string | null;
  createdAt: string;
}

export interface SummaryJobContext {
  id: string;
  traceId: string;
  chunkId: string;
  baseRevisionId: string;
  jobNonce: string;
  inputHash: string;
  eventWatermark: string;
  branchKind: "live" | "final";
  promptVersion: string;
  policyVersion: string;
  allowedEventIds: string[];
  allowedArtifactIds: string[];
  allowedAgentIds: string[];
  eventSketch: string[];
  reducerFacts: ReducerRawFact[];
  registeredArtifactIds: string[];
  graph: ReducerGraphState;
}

export interface SummaryCommitInput {
  state: ReducerGraphState;
  changedNodeIds: string[];
  changedEdgeIds: string[];
  provider: string;
  model: string;
  requestHash: string;
  responseHash: string;
  diagnostics: string[];
  egress: "none" | "local" | "cloud";
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface RepositoryTopologyDependencies {
  lookupTopologyCapability(sourceKind: TraceSourceKind, adapterVersion: string): TopologyCapability;
}

export class IntentTraceRepository {
  constructor(
    private readonly sql: Sql,
    private readonly topology?: RepositoryTopologyDependencies,
  ) {}

  async ensureTrace(rawInput: RawTraceEventInput): Promise<void> {
    const input = RawTraceEventInputSchema.parse(rawInput);
    await this.sql.begin(async (tx) => this.ensureTraceTransaction(tx, input));
  }

  private async ensureTraceTransaction(
    tx: TransactionSql,
    input: RawTraceEventInput,
  ): Promise<void> {
    await tx`
      insert into workspaces (id, slug, name)
      values (${input.workspaceId}, ${`workspace-${input.workspaceId}`}, ${input.workspaceName ?? "Local workspace"})
      on conflict (id) do nothing
    `;
    await tx`
      insert into projects (id, workspace_id, slug, name)
      values (${input.projectId}, ${input.workspaceId}, ${`project-${input.projectId}`}, ${input.projectName ?? "Imported project"})
      on conflict (id) do nothing
    `;
    await tx`
      insert into traces (id, project_id, title)
      values (${input.traceId}, ${input.projectId}, ${input.traceTitle ?? input.name})
      on conflict (id) do nothing
    `;
  }

  async registerArtifact(input: Omit<ArtifactRecord, "id" | "redacted">): Promise<ArtifactRecord> {
    const rows = await this.sql<
      Array<{
        id: string;
        trace_id: string;
        sha256: string;
        byte_length: string;
        media_type: string;
        storage_key: string;
        redacted: boolean;
      }>
    >`
      insert into artifacts (trace_id, sha256, byte_length, media_type, storage_key)
      values (${input.traceId}, ${input.sha256}, ${input.byteLength}, ${input.mediaType}, ${input.storageKey})
      on conflict (trace_id, sha256) do update set media_type = excluded.media_type
      returning id, trace_id, sha256, byte_length, media_type, storage_key, redacted
    `;
    const row = rows[0];
    if (!row) throw new Error("artifact insert returned no row");
    return {
      id: row.id,
      traceId: row.trace_id,
      sha256: row.sha256,
      byteLength: Number(row.byte_length),
      mediaType: row.media_type,
      storageKey: row.storage_key,
      redacted: row.redacted,
    };
  }

  async getArtifact(traceId: string, artifactId: string): Promise<ArtifactRecord> {
    const rows = await this.sql<
      Array<{
        id: string;
        trace_id: string;
        sha256: string;
        byte_length: string;
        media_type: string;
        storage_key: string;
        redacted: boolean;
      }>
    >`
      select id, trace_id, sha256, byte_length, media_type, storage_key, redacted
      from artifacts where trace_id = ${traceId} and id = ${artifactId}
    `;
    const row = rows[0];
    if (!row) throw new RepositoryNotFoundError("artifact");
    return {
      id: row.id,
      traceId: row.trace_id,
      sha256: row.sha256,
      byteLength: Number(row.byte_length),
      mediaType: row.media_type,
      storageKey: row.storage_key,
      redacted: row.redacted,
    };
  }

  async ingest(rawInput: RawTraceEventInput): Promise<IngestResult> {
    const input = RawTraceEventInputSchema.parse(rawInput);
    const eventHash = payloadHash(eventHashInput(input));
    return this.sql.begin(async (tx) => this.ingestTransaction(tx, input, eventHash));
  }

  private async ingestTransaction(
    tx: TransactionSql,
    input: RawTraceEventInput,
    eventHash: string,
  ): Promise<IngestResult> {
    await this.ensureTraceTransaction(tx, input);

    const traceRows = await tx<Array<{ next_ingest_seq: string; status: TraceSummary["status"] }>>`
      select next_ingest_seq, status from traces where id = ${input.traceId} for update
    `;
    const trace = traceRows[0];
    if (!trace) throw new RepositoryNotFoundError("trace");

    const existing = await tx<Array<RawEventRow>>`
      select e.*, p.workspace_id, t.project_id
      from raw_events e
      join traces t on t.id = e.trace_id
      join projects p on p.id = t.project_id
      where e.trace_id = ${input.traceId}
        and e.source_kind = ${input.source.kind}
        and e.source_instance_id = ${input.source.sourceInstanceId}
        and e.source_event_id = ${input.source.sourceEventId}
    `;
    if (existing[0]) {
      if (existing[0].event_hash !== eventHash) throw new IntegrityConflictError(existing[0].id);
      return {
        event: mapRawEvent(existing[0]),
        duplicate: true,
        traceStale: trace.status === "stale",
        warnings: causationWarnings(existing[0].attributes ?? {}),
      };
    }
    let causationEventId = input.causationEventId ?? null;
    const warnings: IngestWarning[] = [];
    let attributes = input.attributes as Record<string, unknown>;
    if (input.causationSourceEventId) {
      const causalRows = await tx<Array<{ id: string }>>`
        select id from raw_events
        where trace_id = ${input.traceId}
          and source_kind = ${input.source.kind}
          and source_instance_id = ${input.source.sourceInstanceId}
          and source_event_id = ${input.causationSourceEventId}
        limit 1
      `;
      causationEventId = causalRows[0]?.id ?? null;
      if (!causationEventId) {
        const warning = {
          code: "causation_source_event_unresolved" as const,
          sourceEventId: input.causationSourceEventId,
        };
        warnings.push(warning);
        attributes = { ...attributes, intenttraceWarnings: [warning] };
      }
    }

    const eventId = randomUUID();
    const ingestSeq = String(trace.next_ingest_seq);
    const completed = input.kind === "trace_complete";
    const late = !completed && (trace.status === "completed" || trace.status === "stale");
    await tx`
      insert into raw_events (
        id, trace_id, ingest_seq, source_kind, source_format_version, adapter_version,
        source_instance_id, source_event_id, event_hash, occurred_at, kind, name, status,
        subject_id, causation_event_id, agent_id, span_id, parent_span_id,
        payload_sha256, payload_ref, payload_byte_length, artifact_refs, attributes
      ) values (
        ${eventId}, ${input.traceId}, ${ingestSeq}, ${input.source.kind},
        ${input.source.formatVersion}, ${input.source.adapterVersion},
        ${input.source.sourceInstanceId}, ${input.source.sourceEventId}, ${eventHash},
        ${input.occurredAt}, ${input.kind}, ${input.name}, ${input.status},
        ${input.subjectId ?? null}, ${causationEventId}, ${input.agentId ?? null},
        ${input.spanId ?? null}, ${input.parentSpanId ?? null},
        ${input.payloadRef?.sha256 ?? null}, ${input.payloadRef?.artifactId ?? null},
        ${input.payloadRef?.byteLength ?? null}, ${tx.json(input.artifactRefs)},
        ${tx.json(attributes as postgres.JSONValue)}
      )
    `;

    if (input.agentId) {
      await tx`
        insert into agents (trace_id, source_agent_id, display_name, attributes)
        values (${input.traceId}, ${input.agentId}, ${input.agentId}, ${tx.json({})})
        on conflict (trace_id, source_agent_id) do nothing
      `;
    }

    await tx`
      update traces set
        next_ingest_seq = next_ingest_seq + 1,
        status = ${completed ? "completed" : late ? "stale" : trace.status},
        completion_watermark = case when ${completed} then ${ingestSeq} else completion_watermark end,
        updated_at = now()
      where id = ${input.traceId}
    `;
    if (late) {
      await tx`
        update semantic_revisions set stale = true
        where trace_id = ${input.traceId} and branch_kind = 'final' and stale = false
      `;
    }

    await tx`
      insert into semantic_revisions (trace_id, parent_revision_id, branch_kind, branch_sequence, event_watermark, stale)
      values (${input.traceId}, null, 'live', 0, 0, false)
      on conflict (trace_id, branch_kind, branch_sequence) do nothing
    `;
    const baseRows = await tx<Array<{ id: string }>>`
      select id from semantic_revisions where trace_id = ${input.traceId}
      order by created_at desc, id desc limit 1
    `;
    const baseRevisionId = baseRows[0]?.id;
    const isLaneBoundary = input.kind === "agent_start" || input.kind === "agent_end";
    if (baseRevisionId && isLaneBoundary && BigInt(ingestSeq) > 1n) {
      const priorWatermark = String(BigInt(ingestSeq) - 1n);
      const priorInputHash = payloadHash({
        traceId: input.traceId,
        eventWatermark: priorWatermark,
        baseRevisionId,
      });
      const priorJobs = await tx<Array<{ id: string }>>`
        insert into summary_jobs (
          trace_id, chunk_id, base_revision_id, job_nonce, input_hash, event_watermark,
          branch_kind, prompt_version, policy_version
        ) values (
          ${input.traceId}, ${randomUUID()}, ${baseRevisionId}, ${randomUUID()}, ${priorInputHash},
          ${priorWatermark}, ${late ? "final" : "live"}, 'mock-v1', 'local-safe-v1'
        )
        on conflict (trace_id, input_hash) do nothing
        returning id
      `;
      if (priorJobs[0]) {
        await tx`
          insert into stream_events (trace_id, type, payload)
          values (${input.traceId}, 'semantic_chunk.pending', ${tx.json({ jobId: priorJobs[0].id, eventWatermark: priorWatermark })})
        `;
      }
    }
    const shouldSummarize =
      Boolean(baseRevisionId) &&
      (ingestSeq === "1" || BigInt(ingestSeq) % 50n === 0n || isLaneBoundary || completed || late);
    if (baseRevisionId && shouldSummarize) {
      const inputHash = payloadHash({
        traceId: input.traceId,
        eventWatermark: ingestSeq,
        baseRevisionId,
      });
      const jobs = await tx<Array<{ id: string }>>`
        insert into summary_jobs (
          trace_id, chunk_id, base_revision_id, job_nonce, input_hash, event_watermark,
          branch_kind, prompt_version, policy_version
        ) values (
          ${input.traceId}, ${randomUUID()}, ${baseRevisionId}, ${randomUUID()}, ${inputHash},
          ${ingestSeq}, ${completed || late ? "final" : "live"}, 'mock-v1', 'local-safe-v1'
        )
        on conflict (trace_id, input_hash) do nothing
        returning id
      `;
      if (jobs[0]) {
        await tx`
          insert into stream_events (trace_id, type, payload)
          values (${input.traceId}, 'semantic_chunk.pending', ${tx.json({ jobId: jobs[0].id, eventWatermark: ingestSeq })})
        `;
      }
    }
    await tx`
      insert into stream_events (trace_id, type, payload)
      values (
        ${input.traceId},
        ${completed ? "trace.completed" : "raw_event.appended"},
        ${tx.json({ eventId, ingestSeq, kind: input.kind, late })}
      )
    `;

    const inserted = await tx<Array<RawEventRow>>`
      select e.*, p.workspace_id, t.project_id
      from raw_events e
      join traces t on t.id = e.trace_id
      join projects p on p.id = t.project_id
      where e.id = ${eventId}
    `;
    if (!inserted[0]) throw new Error("raw event insert returned no row");
    return { event: mapRawEvent(inserted[0]), duplicate: false, traceStale: late, warnings };
  }

  async listTraces(limit = 50): Promise<{ traces: TraceSummary[]; nextCursor: null }> {
    const safeLimit = Math.max(1, Math.min(200, limit));
    const rows = await this.sql<Array<TraceRow>>`
      select t.id, t.project_id, t.title, t.status,
        count(e.id)::bigint as event_count,
        coalesce(max(e.ingest_seq), 0)::bigint as latest_ingest_seq,
        (
          select r.id from semantic_revisions r
          where r.trace_id = t.id order by r.created_at desc, r.id desc limit 1
        ) as latest_revision_id,
        t.created_at, t.updated_at
      from traces t
      left join raw_events e on e.trace_id = t.id
      group by t.id
      order by t.updated_at desc, t.id desc
      limit ${safeLimit}
    `;
    return { traces: rows.map(mapTrace), nextCursor: null };
  }

  /** Batch counterpart of `getTrace`; unknown ids are simply absent from the result. */
  async listTracesByIds(ids: readonly string[]): Promise<TraceSummary[]> {
    if (ids.length === 0) return [];
    const rows = await this.sql<Array<TraceRow>>`
      select t.id, t.project_id, t.title, t.status,
        count(e.id)::bigint as event_count,
        coalesce(max(e.ingest_seq), 0)::bigint as latest_ingest_seq,
        (
          select r.id from semantic_revisions r
          where r.trace_id = t.id order by r.created_at desc, r.id desc limit 1
        ) as latest_revision_id,
        t.created_at, t.updated_at
      from traces t
      left join raw_events e on e.trace_id = t.id
      where t.id = any(${this.sql.array([...ids])}::uuid[])
      group by t.id
      order by t.updated_at desc, t.id desc
    `;
    return rows.map(mapTrace);
  }

  /** Maintenance-only exhaustive trace enumeration; intentionally has no UI list cap. */
  async listAllTraceIds(): Promise<string[]> {
    const rows = await this.sql<Array<{ id: string }>>`
      select id from traces order by created_at, id
    `;
    return rows.map((row) => row.id);
  }

  async getTrace(traceId: string): Promise<TraceSummary> {
    const rows = await this.sql<Array<TraceRow>>`
      select t.id, t.project_id, t.title, t.status,
        count(e.id)::bigint as event_count,
        coalesce(max(e.ingest_seq), 0)::bigint as latest_ingest_seq,
        (
          select r.id from semantic_revisions r
          where r.trace_id = t.id order by r.created_at desc, r.id desc limit 1
        ) as latest_revision_id,
        t.created_at, t.updated_at
      from traces t
      left join raw_events e on e.trace_id = t.id
      where t.id = ${traceId}
      group by t.id
    `;
    if (!rows[0]) throw new RepositoryNotFoundError("trace");
    return mapTrace(rows[0]);
  }

  async listRawEvents(
    traceId: string,
    afterSeq = 0,
    limit = 200,
  ): Promise<{ events: RawTraceEvent[]; nextCursor: string | null }> {
    const safeLimit = Math.max(1, Math.min(1000, limit));
    const rows = await this.sql<Array<RawEventRow>>`
      select e.*, p.workspace_id, t.project_id
      from raw_events e
      join traces t on t.id = e.trace_id
      join projects p on p.id = t.project_id
      where e.trace_id = ${traceId} and e.ingest_seq > ${afterSeq}
      order by e.ingest_seq asc
      limit ${safeLimit + 1}
    `;
    const hasMore = rows.length > safeLimit;
    const visible = hasMore ? rows.slice(0, safeLimit) : rows;
    return {
      events: visible.map(mapRawEvent),
      nextCursor: hasMore && visible.at(-1) ? String(visible.at(-1)?.ingest_seq) : null,
    };
  }

  async getAgentTimeline(traceId: string): Promise<AgentTimelineLane[]> {
    const rows = await this.sql<
      Array<{
        agent_id: string;
        display_name: string;
        event_ids: string[];
        started_at: Date;
        ended_at: Date;
        error_count: number;
      }>
    >`
      select e.agent_id,
        coalesce(a.display_name, e.agent_id) as display_name,
        array_agg(e.id order by e.occurred_at, e.ingest_seq) as event_ids,
        min(e.occurred_at) as started_at,
        max(e.occurred_at) as ended_at,
        count(*) filter (where e.status = 'error')::int as error_count
      from raw_events e
      left join agents a on a.trace_id = e.trace_id and a.source_agent_id = e.agent_id
      where e.trace_id = ${traceId} and e.agent_id is not null
      group by e.agent_id, a.display_name
      order by min(e.occurred_at), e.agent_id
    `;
    return rows.map((row) => ({
      agentId: row.agent_id,
      displayName: row.display_name,
      eventIds: row.event_ids,
      startedAt: toIso(row.started_at),
      endedAt: toIso(row.ended_at),
      errorCount: row.error_count,
    }));
  }

  async listStreamEvents(
    traceId: string,
    afterId: bigint,
    limit = 500,
  ): Promise<StreamEventRecord[]> {
    const rows = await this.sql<
      Array<{
        id: string | bigint;
        trace_id: string;
        revision_id: string | null;
        type: string;
        payload: Record<string, unknown>;
        occurred_at: Date;
      }>
    >`
      select id, trace_id, revision_id, type, payload, occurred_at
      from stream_events
      where trace_id = ${traceId} and id > ${afterId.toString()}
      order by id asc
      limit ${Math.max(1, Math.min(1000, limit))}
    `;
    return rows.map((row) => ({
      id: String(row.id),
      traceId: row.trace_id,
      revisionId: row.revision_id,
      type: row.type,
      payload: row.payload,
      occurredAt: toIso(row.occurred_at),
    }));
  }

  async getStreamBounds(
    traceId: string,
  ): Promise<{ earliest: bigint | null; latest: bigint | null }> {
    const rows = await this.sql<
      Array<{ earliest: string | bigint | null; latest: string | bigint | null }>
    >`
      select min(id) as earliest, max(id) as latest from stream_events where trace_id = ${traceId}
    `;
    return {
      earliest:
        rows[0]?.earliest === null || rows[0]?.earliest === undefined
          ? null
          : BigInt(rows[0].earliest),
      latest:
        rows[0]?.latest === null || rows[0]?.latest === undefined ? null : BigInt(rows[0].latest),
    };
  }

  async listProviderCalls(traceId: string): Promise<ProviderCallAudit[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        summary_job_id: string;
        provider: string;
        model: string;
        status: string;
        input_tokens: string | bigint | null;
        output_tokens: string | bigint | null;
        cost_usd: string | null;
        created_at: Date;
      }>
    >`
      select c.id, c.summary_job_id, c.provider, c.model, c.status,
        c.input_tokens, c.output_tokens, c.cost_usd, c.created_at
      from provider_calls c join summary_jobs j on j.id = c.summary_job_id
      where j.trace_id = ${traceId} order by c.created_at, c.id
    `;
    return rows.map((row) => ({
      id: row.id,
      summaryJobId: row.summary_job_id,
      provider: row.provider,
      model: row.model,
      status: row.status,
      inputTokens: row.input_tokens === null ? null : String(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : String(row.output_tokens),
      costUsd: row.cost_usd,
      createdAt: toIso(row.created_at),
    }));
  }

  async getProviderSpendToday(): Promise<number> {
    const rows = await this.sql<Array<{ total: string }>>`
      select coalesce(sum(cost_usd), 0)::text as total from provider_calls
      where created_at >= date_trunc('day', now()) and status = 'committed'
    `;
    return Number(rows[0]?.total ?? 0);
  }

  async listRevisions(traceId: string, limit: number): Promise<SemanticRevision[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        trace_id: string;
        parent_revision_id: string | null;
        branch_kind: string;
        event_watermark: string | bigint;
        created_at: Date;
        source_job_id: string | null;
        stale: boolean;
      }>
    >`
      select id, trace_id, parent_revision_id, branch_kind, event_watermark,
        created_at, source_job_id, stale
      from semantic_revisions where trace_id = ${traceId}
      order by created_at desc, id desc limit ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      traceId: row.trace_id,
      parentRevisionId: row.parent_revision_id,
      branchKind: row.branch_kind as SemanticRevision["branchKind"],
      eventWatermark: String(row.event_watermark),
      createdAt: toIso(row.created_at),
      sourceJobId: row.source_job_id,
      stale: Boolean(row.stale),
    }));
  }

  async getGraph(traceId: string, revisionId?: string): Promise<SemanticGraphSnapshot | null> {
    const revisions = revisionId
      ? await this.sql<Array<Record<string, unknown>>>`
          select * from semantic_revisions where trace_id = ${traceId} and id = ${revisionId}
        `
      : await this.sql<Array<Record<string, unknown>>>`
          select * from semantic_revisions where trace_id = ${traceId}
          order by created_at desc, id desc limit 1
        `;
    const revision = revisions[0];
    if (!revision) return null;
    const id = String(revision.id);
    const nodeRows = await this.sql<Array<Record<string, unknown>>>`
      select n.*,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'kind', c.kind, 'text', c.text, 'provenance', c.provenance,
              'confidence', c.confidence,
              'evidenceEventIds', coalesce((select jsonb_agg(ce.event_id) from claim_evidence ce where ce.claim_id = c.id), '[]'::jsonb)
            ) order by c.ordinal
          ) filter (where c.id is not null), '[]'::jsonb
        ) as claims
      from revision_node_members m
      join semantic_node_versions n on n.id = m.node_version_id
      left join node_claims c on c.node_version_id = n.id
      where m.revision_id = ${id}
      group by n.id
      order by n.created_at, n.logical_node_id
    `;
    const edgeRows = await this.sql<Array<Record<string, unknown>>>`
      select e.* from revision_edge_members m
      join semantic_edge_versions e on e.id = m.edge_version_id
      where m.revision_id = ${id}
        and e.evidence_event_ids is not null
        and e.provenance is not null
      order by e.created_at, e.logical_edge_id
    `;
    return {
      revision: {
        id,
        traceId: String(revision.trace_id),
        parentRevisionId: revision.parent_revision_id ? String(revision.parent_revision_id) : null,
        branchKind: revision.branch_kind as SemanticGraphSnapshot["revision"]["branchKind"],
        eventWatermark: String(revision.event_watermark),
        createdAt: toIso(revision.created_at as Date),
        sourceJobId: revision.source_job_id ? String(revision.source_job_id) : null,
        stale: Boolean(revision.stale),
      },
      nodes: nodeRows.map((row) => ({
        id: String(row.id),
        logicalNodeId: String(row.logical_node_id),
        traceId: String(row.trace_id),
        kind: row.kind as SemanticGraphSnapshot["nodes"][number]["kind"],
        status: row.status as SemanticGraphSnapshot["nodes"][number]["status"],
        title: String(row.title),
        claims: row.claims as SemanticGraphSnapshot["nodes"][number]["claims"],
        primaryParentId: row.primary_parent_id ? String(row.primary_parent_id) : null,
        primaryAgentId: row.primary_agent_id ? String(row.primary_agent_id) : null,
        participantAgentIds: (row.participant_agent_ids as string[]) ?? [],
        artifactIds: (row.artifact_ids as string[]) ?? [],
        pinnedByHuman: Boolean(row.pinned_by_human),
        startedAt: row.started_at ? toIso(row.started_at as Date) : null,
        endedAt: row.ended_at ? toIso(row.ended_at as Date) : null,
        layout: (row.layout as { x: number; y: number } | null) ?? null,
      })),
      edges: edgeRows.map((row) => ({
        id: String(row.id),
        logicalEdgeId: String(row.logical_edge_id),
        traceId: String(row.trace_id),
        sourceNodeId: String(row.source_node_id),
        targetNodeId: String(row.target_node_id),
        kind: row.kind as SemanticGraphSnapshot["edges"][number]["kind"],
        retired: Boolean(row.retired),
        evidenceEventIds: [...((row.evidence_event_ids as string[]) ?? [])],
        provenance: row.provenance as Provenance,
      })),
    };
  }

  async getObservedTopology(
    traceId: string,
    revisionId?: string,
  ): Promise<{
    observed: TraceTopology["observed"];
    sources: Array<{ sourceKind: TraceSourceKind; adapterVersion: string }>;
  }> {
    const revisionRows = revisionId
      ? await this.sql<Array<{ id: string }>>`
          select id from semantic_revisions where trace_id = ${traceId} and id = ${revisionId}
        `
      : await this.sql<Array<{ id: string }>>`
          select id from semantic_revisions where trace_id = ${traceId}
          order by created_at desc, id desc limit 1
        `;
    const selectedRevisionId = revisionRows[0]?.id ?? null;
    const [rawCounts, edgeCounts, sourceRows] = await Promise.all([
      this.sql<Array<{ lanes: number; lanes_with_parent: number }>>`
        select
          count(distinct agent_id)::int as lanes,
          count(distinct agent_id) filter (
            where agent_id is not null
              and jsonb_typeof(attributes -> 'parentAgentId') = 'string'
          )::int as lanes_with_parent
        from raw_events where trace_id = ${traceId}
      `,
      selectedRevisionId
        ? this.sql<Array<{ spawn_edges: number; peer_edges: number }>>`
            select
              count(*) filter (where e.kind = 'decomposes_to')::int as spawn_edges,
              count(*) filter (
                where e.kind = 'hands_off_to'
                  and exists (
                    select 1
                    from jsonb_array_elements_text(e.evidence_event_ids) evidence(event_id)
                    join raw_events raw on raw.id = evidence.event_id::uuid
                    where raw.trace_id = ${traceId}
                      and jsonb_typeof(raw.attributes -> 'senderAgentId') = 'string'
                      and jsonb_typeof(raw.attributes -> 'recipientAgentId') = 'string'
                      and raw.attributes ->> 'senderAgentId' <> raw.attributes ->> 'recipientAgentId'
                  )
              )::int as peer_edges
            from revision_edge_members member
            join semantic_edge_versions e on e.id = member.edge_version_id
            where member.revision_id = ${selectedRevisionId}
              and e.retired = false
              and e.evidence_event_ids is not null
              and e.provenance is not null
          `
        : Promise.resolve([{ spawn_edges: 0, peer_edges: 0 }]),
      this.sql<Array<{ source_kind: TraceSourceKind; adapter_version: string }>>`
        select distinct source_kind, adapter_version
        from raw_events where trace_id = ${traceId}
        order by source_kind, adapter_version
      `,
    ]);
    return {
      observed: {
        lanes: rawCounts[0]?.lanes ?? 0,
        lanesWithParent: rawCounts[0]?.lanes_with_parent ?? 0,
        spawnEdges: edgeCounts[0]?.spawn_edges ?? 0,
        peerEdges: edgeCounts[0]?.peer_edges ?? 0,
      },
      sources: sourceRows.map((row) => ({
        sourceKind: row.source_kind,
        adapterVersion: row.adapter_version,
      })),
    };
  }

  async listRunnableSummaryJobIds(limit = 100): Promise<string[]> {
    const rows = await this.sql<Array<{ id: string }>>`
      select id from summary_jobs
      where (
        status in ('pending', 'failed') and (next_attempt_at is null or next_attempt_at <= now())
      ) or (
        status = 'running' and updated_at < now() - interval '5 minutes'
      )
      order by trace_id, event_watermark, id
      limit ${Math.max(1, Math.min(1000, limit))}
    `;
    return rows.map((row) => row.id);
  }

  async claimSummaryJob(jobId: string): Promise<SummaryJobContext | null> {
    const job = await this.sql.begin(async (tx) => {
      const runnable = await tx<
        Array<{
          id: string;
          trace_id: string;
          chunk_id: string;
          base_revision_id: string;
          job_nonce: string;
          input_hash: string;
          event_watermark: string | bigint;
          branch_kind: "live" | "final";
          prompt_version: string;
          policy_version: string;
        }>
      >`
        select id, trace_id, chunk_id, base_revision_id, job_nonce, input_hash,
          event_watermark, branch_kind, prompt_version, policy_version
        from summary_jobs
        where id = ${jobId} and (
          (status in ('pending', 'failed') and (next_attempt_at is null or next_attempt_at <= now()))
          or (status = 'running' and updated_at < now() - interval '5 minutes')
        )
        for update
      `;
      const selected = runnable[0];
      if (!selected) return null;

      const latest = await tx<Array<{ id: string }>>`
        select id from semantic_revisions where trace_id = ${selected.trace_id}
        order by created_at desc, id desc limit 1
      `;
      const baseRevisionId = latest[0]?.id;
      if (!baseRevisionId) throw new RepositoryNotFoundError("semantic revision");
      const inputHash = payloadHash({
        traceId: selected.trace_id,
        eventWatermark: String(selected.event_watermark),
        baseRevisionId,
      });
      const jobNonce =
        baseRevisionId === selected.base_revision_id ? selected.job_nonce : randomUUID();
      const rows = await tx<typeof runnable>`
        update summary_jobs set
          status = 'running', attempt_count = attempt_count + 1,
          base_revision_id = ${baseRevisionId}, job_nonce = ${jobNonce}, input_hash = ${inputHash},
          updated_at = now(), last_error_code = null
        where id = ${jobId}
        returning id, trace_id, chunk_id, base_revision_id, job_nonce, input_hash,
          event_watermark, branch_kind, prompt_version, policy_version
      `;
      return rows[0] ?? null;
    });
    if (!job) return null;

    const priorWatermarks = await this.sql<Array<{ watermark: string | bigint }>>`
      select coalesce(max(event_watermark), 0)::bigint as watermark
      from summary_jobs
      where trace_id = ${job.trace_id} and event_watermark < ${String(job.event_watermark)}
    `;
    const chunkAfter = String(priorWatermarks[0]?.watermark ?? 0);
    const [chunkRows, reducerRows, artifactRows, agentRows, snapshot] = await Promise.all([
      this.sql<RawEventRow[]>`
        select re.*
        from raw_events re
        where re.trace_id = ${job.trace_id}
          and re.ingest_seq > ${chunkAfter}
          and re.ingest_seq <= ${String(job.event_watermark)}
        order by re.ingest_seq, re.id
      `,
      this.sql<RawEventRow[]>`
        with claim_facts as (
          select distinct ce.event_id as id
          from revision_node_members rnm
          join node_claims nc on nc.node_version_id = rnm.node_version_id
          join claim_evidence ce on ce.claim_id = nc.id
          where rnm.revision_id = ${job.base_revision_id}
        ), topology_prefix as (
          select id from raw_events
          where trace_id = ${job.trace_id}
            and ingest_seq <= ${String(job.event_watermark)}
            and (
              kind in ('agent_start', 'agent_end', 'agent_handoff', 'tool_result', 'file_write')
              or attributes ?| array[
                'parentAgentId', 'spawnedAgentIds', 'joinedAgentIds', 'joinedBy',
                'senderAgentId', 'recipientAgentId', 'messageId', 'onBehalfOf',
                'assignedBy', 'topologyProvenance'
              ]
            )
        )
        select re.*
        from raw_events re
        join (
          select id from raw_events
          where trace_id = ${job.trace_id}
            and ingest_seq > ${chunkAfter}
            and ingest_seq <= ${String(job.event_watermark)}
          union
          select id from claim_facts
          union
          select id from topology_prefix
        ) selected on selected.id = re.id
        where re.trace_id = ${job.trace_id}
          and re.ingest_seq <= ${String(job.event_watermark)}
        order by re.ingest_seq, re.id
      `,
      this.sql<Array<{ id: string }>>`
        select id from artifacts where trace_id = ${job.trace_id} order by id
      `,
      this.sql<Array<{ source_agent_id: string }>>`
        select source_agent_id from agents where trace_id = ${job.trace_id} order by created_at, id
      `,
      this.getGraph(job.trace_id, job.base_revision_id),
    ]);
    if (!snapshot) {
      await this.failSummaryJob(job.id, "base_revision_missing", false);
      return null;
    }
    return {
      id: job.id,
      traceId: job.trace_id,
      chunkId: job.chunk_id,
      baseRevisionId: job.base_revision_id,
      jobNonce: job.job_nonce,
      inputHash: job.input_hash,
      eventWatermark: String(job.event_watermark),
      branchKind: job.branch_kind,
      promptVersion: job.prompt_version,
      policyVersion: job.policy_version,
      allowedEventIds: chunkRows.map((row) => row.id),
      allowedArtifactIds: [
        ...new Set(
          chunkRows.flatMap((row) => [
            ...(row.payload_ref ? [row.payload_ref] : []),
            ...(row.artifact_refs ?? []),
          ]),
        ),
      ],
      allowedAgentIds: agentRows.map((row) => row.source_agent_id),
      eventSketch: chunkRows.map((row) =>
        JSON.stringify({
          eventId: row.id,
          kind: row.kind,
          status: row.status,
          agentId: row.agent_id ?? "system",
          name: row.name,
          contentType:
            typeof row.attributes?.contentType === "string"
              ? row.attributes.contentType
              : "unknown",
          artifactIds: [
            ...new Set([
              ...(row.payload_ref ? [row.payload_ref] : []),
              ...(row.artifact_refs ?? []),
            ]),
          ],
        }),
      ),
      reducerFacts: reducerRows.map(mapReducerRawFact),
      registeredArtifactIds: artifactRows.map((row) => row.id),
      graph: {
        nodes: snapshot.nodes.map((node) => ({
          logicalNodeId: node.logicalNodeId,
          versionId: node.id,
          kind: node.kind,
          status: node.status,
          title: node.title,
          claims: node.claims,
          primaryParentId: node.primaryParentId,
          primaryAgentId: node.primaryAgentId,
          participantAgentIds: node.participantAgentIds,
          artifactIds: node.artifactIds,
          pinnedByHuman: node.pinnedByHuman,
          startedAt: node.startedAt,
          endedAt: node.endedAt,
          layout: node.layout,
        })),
        edges: snapshot.edges.map((edge) => ({
          logicalEdgeId: edge.logicalEdgeId,
          versionId: edge.id,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          evidenceEventIds: [...edge.evidenceEventIds],
          provenance: edge.provenance,
          kind: edge.kind,
          retired: edge.retired,
        })),
      },
    };
  }

  async failSummaryJob(jobId: string, errorCode: string, retry = true): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<Array<{ trace_id: string }>>`
        update summary_jobs set
          status = ${retry ? "failed" : "cancelled"},
          last_error_code = ${errorCode.slice(0, 120)},
          next_attempt_at = ${retry ? new Date(Date.now() + 5000) : null},
          updated_at = now()
        where id = ${jobId} and status = 'running'
        returning trace_id
      `;
      if (rows[0] && !retry) {
        await tx`
          insert into stream_events (trace_id, type, payload)
          values (${rows[0].trace_id}, 'summary.failed', ${tx.json({ jobId, errorCode, rawOnly: true })})
        `;
      }
    });
  }

  async commitSummaryJob(jobId: string, input: SummaryCommitInput): Promise<string> {
    assertAuditedEdges(input.state);
    const committed = await this.sql.begin(async (tx): Promise<string | null> => {
      const jobs = await tx<
        Array<{
          id: string;
          trace_id: string;
          base_revision_id: string;
          event_watermark: string | bigint;
          branch_kind: "live" | "final";
          status: string;
        }>
      >`
        select id, trace_id, base_revision_id, event_watermark, branch_kind, status
        from summary_jobs where id = ${jobId} for update
      `;
      const job = jobs[0];
      if (!job) throw new RepositoryNotFoundError("summary job");
      const prior = await tx<Array<{ id: string }>>`
        select id from semantic_revisions where source_job_id = ${jobId} limit 1
      `;
      if (prior[0]) return prior[0].id;
      if (job.status !== "running") throw new Error(`summary job is ${job.status}`);
      const traceLocks = await tx<Array<{ id: string }>>`
        select id from traces where id = ${job.trace_id} for update
      `;
      if (!traceLocks[0]) throw new RepositoryNotFoundError("trace");
      const latest = await tx<Array<{ id: string }>>`
        select id from semantic_revisions where trace_id = ${job.trace_id}
        order by created_at desc, id desc limit 1
      `;
      if (latest[0]?.id !== job.base_revision_id) {
        const nextBaseRevisionId = latest[0]?.id;
        if (!nextBaseRevisionId) throw new RepositoryNotFoundError("semantic revision");
        const nextInputHash = payloadHash({
          traceId: job.trace_id,
          eventWatermark: String(job.event_watermark),
          baseRevisionId: nextBaseRevisionId,
        });
        await tx`
          update summary_jobs set
            status = 'pending', base_revision_id = ${nextBaseRevisionId}, job_nonce = ${randomUUID()},
            input_hash = ${nextInputHash}, last_error_code = 'rebased_stale_revision',
            next_attempt_at = null, updated_at = now()
          where id = ${jobId}
        `;
        return null;
      }

      const sequenceRows = await tx<Array<{ value: number }>>`
        select coalesce(max(branch_sequence), -1)::int + 1 as value
        from semantic_revisions where trace_id = ${job.trace_id} and branch_kind = ${job.branch_kind}
      `;
      const revisionId = randomUUID();
      await tx`
        insert into semantic_revisions (
          id, trace_id, parent_revision_id, branch_kind, branch_sequence,
          event_watermark, source_job_id, stale
        ) values (
          ${revisionId}, ${job.trace_id}, ${job.base_revision_id}, ${job.branch_kind},
          ${sequenceRows[0]?.value ?? 0}, ${String(job.event_watermark)}, ${jobId}, false
        )
      `;

      for (const node of input.state.nodes) {
        const inserted = await tx<Array<{ id: string }>>`
          insert into semantic_node_versions (
            id, logical_node_id, trace_id, kind, status, title, primary_parent_id,
            primary_agent_id, participant_agent_ids, artifact_ids, pinned_by_human,
            started_at, ended_at, layout
          ) values (
            ${node.versionId}, ${node.logicalNodeId}, ${job.trace_id}, ${node.kind}, ${node.status},
            ${node.title}, ${node.primaryParentId}, ${node.primaryAgentId},
            ${tx.json(node.participantAgentIds)}, ${tx.json(node.artifactIds)}, ${node.pinnedByHuman},
            ${node.startedAt}, ${node.endedAt},
            ${node.layout ? tx.json(node.layout) : null}
          ) on conflict (id) do nothing returning id
        `;
        if (inserted[0]) {
          for (const [ordinal, claim] of node.claims.entries()) {
            const claimId = randomUUID();
            await tx`
              insert into node_claims (id, node_version_id, kind, text, provenance, confidence, ordinal)
              values (${claimId}, ${node.versionId}, ${claim.kind}, ${claim.text}, ${claim.provenance},
                ${claim.confidence}, ${ordinal})
            `;
            for (const eventId of claim.evidenceEventIds) {
              await tx`
                insert into claim_evidence (claim_id, event_id) values (${claimId}, ${eventId})
              `;
            }
          }
        }
        await tx`
          insert into revision_node_members (revision_id, logical_node_id, node_version_id)
          values (${revisionId}, ${node.logicalNodeId}, ${node.versionId})
        `;
      }

      for (const edge of input.state.edges) {
        await tx`
          insert into semantic_edge_versions (
            id, logical_edge_id, trace_id, source_node_id, target_node_id, kind, retired,
            evidence_event_ids, provenance
          ) values (
            ${edge.versionId}, ${edge.logicalEdgeId}, ${job.trace_id}, ${edge.sourceNodeId},
            ${edge.targetNodeId}, ${edge.kind}, ${edge.retired},
            ${tx.json(edge.evidenceEventIds)}, ${edge.provenance}
          ) on conflict (id) do nothing
        `;
        await tx`
          insert into revision_edge_members (revision_id, logical_edge_id, edge_version_id)
          values (${revisionId}, ${edge.logicalEdgeId}, ${edge.versionId})
        `;
      }

      await tx`
        update summary_jobs set status = 'committed', updated_at = now(), next_attempt_at = null
        where id = ${jobId}
      `;
      if (job.branch_kind === "final") {
        await tx`
          update traces set status = 'completed', completion_watermark = ${String(job.event_watermark)},
            updated_at = now()
          where id = ${job.trace_id}
        `;
      }
      await tx`
        insert into provider_calls (
          summary_job_id, provider, model, request_hash, response_hash,
          input_tokens, output_tokens, cost_usd, redaction_report, status
        ) values (
          ${jobId}, ${input.provider}, ${input.model}, ${input.requestHash}, ${input.responseHash},
          ${input.inputTokens ?? null}, ${input.outputTokens ?? null}, ${input.costUsd ?? null},
          ${tx.json({ egress: input.egress, diagnostics: input.diagnostics })}, 'committed'
        )
      `;
      await tx`
        insert into stream_events (trace_id, revision_id, type, payload)
        values (
          ${job.trace_id}, ${revisionId}, 'semantic_revision.created',
          ${tx.json({
            revisionId,
            eventWatermark: String(job.event_watermark),
            changedNodeIds: input.changedNodeIds,
            changedEdgeIds: input.changedEdgeIds,
          })}
        )
      `;
      return revisionId;
    });
    if (!committed) throw new StaleSummaryJobError();
    return committed;
  }

  async rederiveTopology(traceId: string, revisionId?: string): Promise<string | null> {
    if (!this.topology) {
      throw new Error("topology capability lookup is required for topology rebuild");
    }
    const base = await this.getGraph(traceId, revisionId);
    if (!base) throw new RepositoryNotFoundError("semantic revision");
    const eventWatermark = base.revision.eventWatermark;
    const [traceRows, factRows, artifactRows] = await Promise.all([
      this.sql<Array<{ status: TraceSummary["status"] }>>`
        select status from traces where id = ${traceId}
      `,
      this.sql<RawEventRow[]>`
        select re.*, p.workspace_id, t.project_id
        from raw_events re
        join traces t on t.id = re.trace_id
        join projects p on p.id = t.project_id
        where re.trace_id = ${traceId} and re.ingest_seq <= ${eventWatermark}
        order by re.ingest_seq, re.id
      `,
      this.sql<Array<{ id: string }>>`
        select id from artifacts where trace_id = ${traceId} order by id
      `,
    ]);
    const trace = traceRows[0];
    if (!trace) throw new RepositoryNotFoundError("trace");
    const facts = factRows.map(mapReducerRawFact);
    const capabilities = new Map<string, TopologyCapability>();
    for (const fact of facts) {
      const key = topologyCapabilityKey(fact.sourceKind, fact.adapterVersion);
      if (capabilities.has(key)) continue;
      capabilities.set(
        key,
        this.topology.lookupTopologyCapability(fact.sourceKind, fact.adapterVersion),
      );
    }
    const state: ReducerGraphState = {
      nodes: base.nodes.map((node) => ({
        logicalNodeId: node.logicalNodeId,
        versionId: node.id,
        kind: node.kind,
        status: node.status,
        title: node.title,
        claims: node.claims.map((claim) => ({
          ...claim,
          evidenceEventIds: [...claim.evidenceEventIds],
        })),
        primaryParentId: node.primaryParentId,
        primaryAgentId: node.primaryAgentId,
        participantAgentIds: [...node.participantAgentIds],
        artifactIds: [...node.artifactIds],
        pinnedByHuman: node.pinnedByHuman,
        startedAt: node.startedAt,
        endedAt: node.endedAt,
        layout: node.layout ? { ...node.layout } : null,
      })),
      edges: base.edges.map((edge) => ({
        logicalEdgeId: edge.logicalEdgeId,
        versionId: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        kind: edge.kind,
        retired: edge.retired,
        evidenceEventIds: [...edge.evidenceEventIds],
        provenance: edge.provenance,
      })),
    };
    const derived = deriveTopology(state, {
      traceId,
      eventWatermark,
      facts,
      capabilities,
      registeredArtifactIds: new Set(artifactRows.map((row) => row.id)),
    });

    return this.sql.begin(async (tx) => {
      const lockedTraceRows = await tx<Array<{ status: TraceSummary["status"] }>>`
        select status from traces where id = ${traceId} for update
      `;
      const lockedTrace = lockedTraceRows[0];
      if (!lockedTrace) throw new RepositoryNotFoundError("trace");
      const latestRows = await tx<Array<{ id: string }>>`
        select id from semantic_revisions where trace_id = ${traceId}
        order by created_at desc, id desc limit 1
      `;
      if (latestRows[0]?.id !== base.revision.id) throw new StaleSummaryJobError();
      if (derived.changedNodeIds.length === 0 && derived.changedEdgeIds.length === 0) {
        return null;
      }
      const branchKind = lockedTrace.status === "completed" ? "final" : "live";
      const sequenceRows = await tx<Array<{ value: number }>>`
        select coalesce(max(branch_sequence), -1)::int + 1 as value
        from semantic_revisions where trace_id = ${traceId} and branch_kind = ${branchKind}
      `;
      const rebuiltRevisionId = randomUUID();
      await tx`
        insert into semantic_revisions (
          id, trace_id, parent_revision_id, branch_kind, branch_sequence,
          event_watermark, source_job_id, stale
        ) values (
          ${rebuiltRevisionId}, ${traceId}, ${base.revision.id}, ${branchKind},
          ${sequenceRows[0]?.value ?? 0}, ${eventWatermark}, null, false
        )
      `;
      for (const node of derived.state.nodes) {
        const prior = state.nodes.find(
          (candidate) => candidate.logicalNodeId === node.logicalNodeId,
        );
        if (!prior || prior.versionId !== node.versionId) {
          await tx`
            insert into semantic_node_versions (
              id, logical_node_id, trace_id, kind, status, title, primary_parent_id,
              primary_agent_id, participant_agent_ids, artifact_ids, pinned_by_human,
              started_at, ended_at, layout
            ) values (
              ${node.versionId}, ${node.logicalNodeId}, ${traceId}, ${node.kind}, ${node.status},
              ${node.title}, ${node.primaryParentId}, ${node.primaryAgentId},
              ${tx.json(node.participantAgentIds)}, ${tx.json(node.artifactIds)},
              ${node.pinnedByHuman}, ${node.startedAt}, ${node.endedAt},
              ${node.layout ? tx.json(node.layout) : null}
            ) on conflict (id) do nothing
          `;
          for (const [ordinal, claim] of node.claims.entries()) {
            const claimId = randomUUID();
            await tx`
              insert into node_claims (id, node_version_id, kind, text, provenance, confidence, ordinal)
              values (${claimId}, ${node.versionId}, ${claim.kind}, ${claim.text},
                ${claim.provenance}, ${claim.confidence}, ${ordinal})
            `;
            for (const eventId of claim.evidenceEventIds) {
              await tx`insert into claim_evidence (claim_id, event_id) values (${claimId}, ${eventId})`;
            }
          }
        }
        await tx`
          insert into revision_node_members (revision_id, logical_node_id, node_version_id)
          values (${rebuiltRevisionId}, ${node.logicalNodeId}, ${node.versionId})
        `;
      }
      for (const edge of derived.state.edges) {
        const prior = state.edges.find(
          (candidate) => candidate.logicalEdgeId === edge.logicalEdgeId,
        );
        if (!prior || prior.versionId !== edge.versionId) {
          await tx`
            insert into semantic_edge_versions (
              id, logical_edge_id, trace_id, source_node_id, target_node_id, kind, retired,
              evidence_event_ids, provenance
            ) values (
              ${edge.versionId}, ${edge.logicalEdgeId}, ${traceId}, ${edge.sourceNodeId},
              ${edge.targetNodeId}, ${edge.kind}, ${edge.retired},
              ${tx.json(edge.evidenceEventIds)}, ${edge.provenance}
            ) on conflict (id) do nothing
          `;
        }
        await tx`
          insert into revision_edge_members (revision_id, logical_edge_id, edge_version_id)
          values (${rebuiltRevisionId}, ${edge.logicalEdgeId}, ${edge.versionId})
        `;
      }
      await tx`
        insert into stream_events (trace_id, revision_id, type, payload)
        values (${traceId}, ${rebuiltRevisionId}, 'semantic_revision.created', ${tx.json({
          revisionId: rebuiltRevisionId,
          eventWatermark,
          changedNodeIds: derived.changedNodeIds,
          changedEdgeIds: derived.changedEdgeIds,
          provider: "deterministic-topology-rebuild",
        })})
      `;
      return rebuiltRevisionId;
    });
  }

  async editSemanticNode(
    traceId: string,
    logicalNodeId: string,
    input: HumanNodeEdit,
  ): Promise<string> {
    return this.sql.begin(async (tx) => {
      const traceLocks = await tx<Array<{ id: string }>>`
        select id from traces where id = ${traceId} for update
      `;
      if (!traceLocks[0]) throw new RepositoryNotFoundError("trace");
      const baseRows = await tx<Array<{ id: string; event_watermark: string | bigint }>>`
        select id, event_watermark from semantic_revisions
        where trace_id = ${traceId} order by created_at desc, id desc limit 1
      `;
      const base = baseRows[0];
      if (!base) throw new RepositoryNotFoundError("semantic revision");
      if (base.id !== input.baseRevisionId) throw new StaleSummaryJobError();
      const currentRows = await tx<Array<Record<string, unknown>>>`
        select n.* from revision_node_members m
        join semantic_node_versions n on n.id = m.node_version_id
        where m.revision_id = ${base.id} and m.logical_node_id = ${logicalNodeId}
      `;
      const current = currentRows[0];
      if (!current) throw new RepositoryNotFoundError("semantic node");
      const versionId = randomUUID();
      await tx`
        insert into semantic_node_versions (
          id, logical_node_id, trace_id, kind, status, title, primary_parent_id,
          primary_agent_id, participant_agent_ids, artifact_ids, pinned_by_human,
          started_at, ended_at, layout
        ) values (
          ${versionId}, ${logicalNodeId}, ${traceId}, ${String(current.kind)},
          ${input.status ?? String(current.status)}, ${input.title ?? String(current.title)},
          ${current.primary_parent_id ? String(current.primary_parent_id) : null},
          ${current.primary_agent_id ? String(current.primary_agent_id) : null},
          ${tx.json((current.participant_agent_ids as string[]) ?? [])},
          ${tx.json((current.artifact_ids as string[]) ?? [])},
          ${input.pinned ?? Boolean(current.pinned_by_human)},
          ${current.started_at as Date | null}, ${current.ended_at as Date | null},
          ${current.layout ? tx.json(current.layout as postgres.JSONValue) : null}
        )
      `;
      await tx`
        insert into node_claims (node_version_id, kind, text, provenance, confidence, ordinal)
        select ${versionId}, kind, text, provenance, confidence, ordinal
        from node_claims where node_version_id = ${String(current.id)} order by ordinal
      `;
      await tx`
        insert into claim_evidence (claim_id, event_id)
        select copied.id, evidence.event_id
        from node_claims copied
        join node_claims original on original.node_version_id = ${String(current.id)}
          and original.ordinal = copied.ordinal
        join claim_evidence evidence on evidence.claim_id = original.id
        where copied.node_version_id = ${versionId}
      `;
      const sequenceRows = await tx<Array<{ value: number }>>`
        select coalesce(max(branch_sequence), -1)::int + 1 as value
        from semantic_revisions where trace_id = ${traceId} and branch_kind = 'human'
      `;
      const revisionId = randomUUID();
      await tx`
        insert into semantic_revisions (
          id, trace_id, parent_revision_id, branch_kind, branch_sequence, event_watermark, stale
        ) values (
          ${revisionId}, ${traceId}, ${base.id}, 'human', ${sequenceRows[0]?.value ?? 0},
          ${String(base.event_watermark)}, false
        )
      `;
      await tx`
        insert into revision_node_members (revision_id, logical_node_id, node_version_id)
        select ${revisionId}, logical_node_id,
          case when logical_node_id = ${logicalNodeId} then ${versionId}::uuid else node_version_id end
        from revision_node_members where revision_id = ${base.id}
      `;
      await tx`
        insert into revision_edge_members (revision_id, logical_edge_id, edge_version_id)
        select ${revisionId}, logical_edge_id, edge_version_id
        from revision_edge_members where revision_id = ${base.id}
      `;
      if (input.feedback) {
        await tx`
          insert into node_feedback (node_version_id, kind, comment)
          values (${versionId}, 'human_edit', ${input.feedback})
        `;
      }
      await tx`
        insert into stream_events (trace_id, revision_id, type, payload)
        values (${traceId}, ${revisionId}, 'semantic_node.updated',
          ${tx.json({ logicalNodeId, revisionId, pinned: input.pinned })})
      `;
      return revisionId;
    });
  }

  async deleteTraceData(traceId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`delete from node_feedback where node_version_id in (select id from semantic_node_versions where trace_id = ${traceId})`;
      await tx`delete from provider_calls where summary_job_id in (select id from summary_jobs where trace_id = ${traceId})`;
      await tx`delete from summary_jobs where trace_id = ${traceId}`;
      await tx`delete from claim_evidence where claim_id in (select c.id from node_claims c join semantic_node_versions n on n.id = c.node_version_id where n.trace_id = ${traceId})`;
      await tx`delete from node_claims where node_version_id in (select id from semantic_node_versions where trace_id = ${traceId})`;
      await tx`delete from revision_edge_members where revision_id in (select id from semantic_revisions where trace_id = ${traceId})`;
      await tx`delete from revision_node_members where revision_id in (select id from semantic_revisions where trace_id = ${traceId})`;
      await tx`delete from semantic_edge_versions where trace_id = ${traceId}`;
      await tx`delete from semantic_node_versions where trace_id = ${traceId}`;
      await tx`delete from stream_events where trace_id = ${traceId}`;
      await tx`delete from semantic_revisions where trace_id = ${traceId}`;
      await tx`delete from artifacts where trace_id = ${traceId}`;
      await tx`delete from raw_events where trace_id = ${traceId}`;
      await tx`delete from agents where trace_id = ${traceId}`;
      const deleted = await tx<Array<{ id: string }>>`
        delete from traces where id = ${traceId} returning id
      `;
      if (!deleted[0]) throw new RepositoryNotFoundError("trace");
    });
  }
}
