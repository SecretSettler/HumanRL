import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const traceStatus = pgEnum("trace_status", ["active", "completed", "stale", "failed"]);
export const semanticBranchKind = pgEnum("semantic_branch_kind", [
  "live",
  "final",
  "human",
  "alternate_model",
]);
export const summaryJobStatus = pgEnum("summary_job_status", [
  "pending",
  "running",
  "committed",
  "failed",
  "cancelled",
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  ...timestamps,
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("projects_workspace_slug_uidx").on(table.workspaceId, table.slug)],
);

export const traces = pgTable(
  "traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    status: traceStatus("status").notNull().default("active"),
    nextIngestSeq: bigint("next_ingest_seq", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    completionWatermark: bigint("completion_watermark", { mode: "bigint" }),
    ...timestamps,
  },
  (table) => [
    index("traces_project_created_idx").on(table.projectId, table.createdAt),
    check("traces_next_ingest_seq_positive", sql`${table.nextIngestSeq} > 0`),
    check(
      "traces_completion_watermark_nonnegative",
      sql`${table.completionWatermark} is null or ${table.completionWatermark} >= 0`,
    ),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "cascade" }),
    sourceAgentId: text("source_agent_id").notNull(),
    displayName: text("display_name").notNull(),
    attributes: jsonb("attributes")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps,
  },
  (table) => [uniqueIndex("agents_trace_source_uidx").on(table.traceId, table.sourceAgentId)],
);

export const rawEvents = pgTable(
  "raw_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "restrict" }),
    ingestSeq: bigint("ingest_seq", { mode: "bigint" }).notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceFormatVersion: text("source_format_version").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    sourceInstanceId: text("source_instance_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    eventHash: char("event_hash", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow().notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    subjectId: text("subject_id"),
    causationEventId: uuid("causation_event_id"),
    agentId: text("agent_id"),
    spanId: text("span_id"),
    parentSpanId: text("parent_span_id"),
    payloadSha256: char("payload_sha256", { length: 64 }),
    payloadRef: text("payload_ref"),
    payloadByteLength: bigint("payload_byte_length", { mode: "bigint" }),
    artifactRefs: jsonb("artifact_refs")
      .notNull()
      .default(sql`'[]'::jsonb`),
    attributes: jsonb("attributes")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    uniqueIndex("raw_events_trace_seq_uidx").on(table.traceId, table.ingestSeq),
    uniqueIndex("raw_events_source_identity_uidx").on(
      table.traceId,
      table.sourceKind,
      table.sourceInstanceId,
      table.sourceEventId,
    ),
    index("raw_events_trace_time_idx").on(table.traceId, table.occurredAt),
    index("raw_events_trace_agent_idx").on(table.traceId, table.agentId, table.occurredAt),
    check("raw_events_ingest_seq_positive", sql`${table.ingestSeq} > 0`),
    check("raw_events_event_hash_format", sql`${table.eventHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "raw_events_payload_hash_format",
      sql`${table.payloadSha256} is null or ${table.payloadSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "raw_events_payload_ref_pair",
      sql`(${table.payloadSha256} is null and ${table.payloadRef} is null and ${table.payloadByteLength} is null) or (${table.payloadSha256} is not null and ${table.payloadRef} is not null and ${table.payloadByteLength} >= 0)`,
    ),
  ],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "restrict" }),
    sha256: char("sha256", { length: 64 }).notNull(),
    byteLength: bigint("byte_length", { mode: "bigint" }).notNull(),
    mediaType: text("media_type").notNull(),
    storageKey: text("storage_key").notNull(),
    redacted: boolean("redacted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("artifacts_trace_hash_uidx").on(table.traceId, table.sha256),
    check("artifacts_sha256_format", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
    check("artifacts_byte_length_nonnegative", sql`${table.byteLength} >= 0`),
  ],
);

export const semanticRevisions = pgTable(
  "semantic_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "restrict" }),
    parentRevisionId: uuid("parent_revision_id"),
    branchKind: semanticBranchKind("branch_kind").notNull(),
    branchSequence: integer("branch_sequence").notNull(),
    eventWatermark: bigint("event_watermark", { mode: "bigint" }).notNull(),
    sourceJobId: uuid("source_job_id"),
    stale: boolean("stale").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("semantic_revisions_trace_branch_seq_uidx").on(
      table.traceId,
      table.branchKind,
      table.branchSequence,
    ),
    index("semantic_revisions_trace_watermark_idx").on(table.traceId, table.eventWatermark),
    check("semantic_revisions_branch_sequence_nonnegative", sql`${table.branchSequence} >= 0`),
    check("semantic_revisions_event_watermark_nonnegative", sql`${table.eventWatermark} >= 0`),
  ],
);

export const semanticNodeVersions = pgTable(
  "semantic_node_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    logicalNodeId: uuid("logical_node_id").notNull(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    primaryParentId: uuid("primary_parent_id"),
    primaryAgentId: text("primary_agent_id"),
    participantAgentIds: jsonb("participant_agent_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    artifactIds: jsonb("artifact_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    pinnedByHuman: boolean("pinned_by_human").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    layout: jsonb("layout"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("semantic_node_versions_trace_logical_idx").on(table.traceId, table.logicalNodeId),
  ],
);

export const semanticEdgeVersions = pgTable(
  "semantic_edge_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    logicalEdgeId: uuid("logical_edge_id").notNull(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "restrict" }),
    sourceNodeId: uuid("source_node_id").notNull(),
    targetNodeId: uuid("target_node_id").notNull(),
    kind: text("kind").notNull(),
    retired: boolean("retired").notNull().default(false),
    evidenceEventIds: jsonb("evidence_event_ids"),
    provenance: text("provenance"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("semantic_edge_versions_trace_logical_idx").on(table.traceId, table.logicalEdgeId),
    check("semantic_edges_no_self_edge", sql`${table.sourceNodeId} <> ${table.targetNodeId}`),
  ],
);

export const revisionNodeMembers = pgTable(
  "revision_node_members",
  {
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => semanticRevisions.id, { onDelete: "cascade" }),
    logicalNodeId: uuid("logical_node_id").notNull(),
    nodeVersionId: uuid("node_version_id")
      .notNull()
      .references(() => semanticNodeVersions.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.revisionId, table.logicalNodeId] })],
);

export const revisionEdgeMembers = pgTable(
  "revision_edge_members",
  {
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => semanticRevisions.id, { onDelete: "cascade" }),
    logicalEdgeId: uuid("logical_edge_id").notNull(),
    edgeVersionId: uuid("edge_version_id")
      .notNull()
      .references(() => semanticEdgeVersions.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.revisionId, table.logicalEdgeId] })],
);

export const nodeClaims = pgTable(
  "node_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeVersionId: uuid("node_version_id")
      .notNull()
      .references(() => semanticNodeVersions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    provenance: text("provenance").notNull(),
    confidence: text("confidence").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    uniqueIndex("node_claims_version_ordinal_uidx").on(table.nodeVersionId, table.ordinal),
    check("node_claims_kind", sql`${table.kind} in ('intent', 'action', 'outcome')`),
    check("node_claims_provenance", sql`${table.provenance} in ('stated', 'inferred', 'mixed')`),
    check("node_claims_confidence", sql`${table.confidence} in ('high', 'medium', 'low')`),
    check("node_claims_ordinal_nonnegative", sql`${table.ordinal} >= 0`),
  ],
);

export const claimEvidence = pgTable(
  "claim_evidence",
  {
    claimId: uuid("claim_id")
      .notNull()
      .references(() => nodeClaims.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => rawEvents.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.claimId, table.eventId] })],
);

export const summaryJobs = pgTable(
  "summary_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "restrict" }),
    chunkId: uuid("chunk_id").notNull(),
    baseRevisionId: uuid("base_revision_id").notNull(),
    jobNonce: uuid("job_nonce").notNull().unique(),
    inputHash: char("input_hash", { length: 64 }).notNull(),
    eventWatermark: bigint("event_watermark", { mode: "bigint" }).notNull(),
    branchKind: semanticBranchKind("branch_kind").notNull(),
    promptVersion: text("prompt_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    status: summaryJobStatus("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("summary_jobs_trace_input_uidx").on(table.traceId, table.inputHash),
    index("summary_jobs_status_attempt_idx").on(table.status, table.nextAttemptAt),
    check("summary_jobs_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
    check("summary_jobs_event_watermark_nonnegative", sql`${table.eventWatermark} >= 0`),
    check("summary_jobs_input_hash_format", sql`${table.inputHash} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const providerCalls = pgTable("provider_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  summaryJobId: uuid("summary_job_id")
    .notNull()
    .references(() => summaryJobs.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  requestHash: char("request_hash", { length: 64 }).notNull(),
  responseHash: char("response_hash", { length: 64 }),
  inputTokens: bigint("input_tokens", { mode: "bigint" }),
  outputTokens: bigint("output_tokens", { mode: "bigint" }),
  costUsd: numeric("cost_usd", { precision: 20, scale: 12 }),
  redactionReport: jsonb("redaction_report")
    .notNull()
    .default(sql`'{}'::jsonb`),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key] }),
    index("idempotency_expiry_idx").on(table.expiresAt),
  ],
);

export const streamEvents = pgTable(
  "stream_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.id, { onDelete: "restrict" }),
    revisionId: uuid("revision_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [index("stream_events_trace_id_idx").on(table.traceId, table.id)],
);

export const collectorCheckpoints = pgTable(
  "collector_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKind: text("source_kind").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    realPath: text("real_path").notNull(),
    fileIdentity: text("file_identity").notNull(),
    byteOffset: bigint("byte_offset", { mode: "bigint" }).notNull(),
    prefixHash: char("prefix_hash", { length: 64 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("collector_checkpoint_source_uidx").on(table.sourceKind, table.sourceIdentity),
  ],
);

export const nodeFeedback = pgTable("node_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  nodeVersionId: uuid("node_version_id")
    .notNull()
    .references(() => semanticNodeVersions.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
