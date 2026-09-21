CREATE TYPE "public"."semantic_branch_kind" AS ENUM('live', 'final', 'human', 'alternate_model');--> statement-breakpoint
CREATE TYPE "public"."summary_job_status" AS ENUM('pending', 'running', 'committed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."trace_status" AS ENUM('active', 'completed', 'stale', 'failed');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"source_agent_id" text NOT NULL,
	"display_name" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"sha256" char(64) NOT NULL,
	"byte_length" bigint NOT NULL,
	"media_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_sha256_format" CHECK ("artifacts"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "artifacts_byte_length_nonnegative" CHECK ("artifacts"."byte_length" >= 0)
);
--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"claim_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	CONSTRAINT "claim_evidence_claim_id_event_id_pk" PRIMARY KEY("claim_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "collector_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_kind" text NOT NULL,
	"source_identity" text NOT NULL,
	"real_path" text NOT NULL,
	"file_identity" text NOT NULL,
	"byte_offset" bigint NOT NULL,
	"prefix_hash" char(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" char(64) NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_records_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "node_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"provenance" text NOT NULL,
	"confidence" text NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "node_claims_kind" CHECK ("node_claims"."kind" in ('intent', 'action', 'outcome')),
	CONSTRAINT "node_claims_provenance" CHECK ("node_claims"."provenance" in ('stated', 'inferred', 'mixed')),
	CONSTRAINT "node_claims_confidence" CHECK ("node_claims"."confidence" in ('high', 'medium', 'low')),
	CONSTRAINT "node_claims_ordinal_nonnegative" CHECK ("node_claims"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "node_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_version_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"summary_job_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"request_hash" char(64) NOT NULL,
	"response_hash" char(64),
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cost_usd" numeric(20, 12),
	"redaction_report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"ingest_seq" bigint NOT NULL,
	"source_kind" text NOT NULL,
	"source_format_version" text NOT NULL,
	"adapter_version" text NOT NULL,
	"source_instance_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"subject_id" text,
	"causation_event_id" uuid,
	"agent_id" text,
	"span_id" text,
	"parent_span_id" text,
	"payload_sha256" char(64),
	"payload_ref" text,
	"payload_byte_length" bigint,
	"artifact_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "raw_events_ingest_seq_positive" CHECK ("raw_events"."ingest_seq" > 0),
	CONSTRAINT "raw_events_payload_hash_format" CHECK ("raw_events"."payload_sha256" is null or "raw_events"."payload_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "raw_events_payload_ref_pair" CHECK (("raw_events"."payload_sha256" is null and "raw_events"."payload_ref" is null and "raw_events"."payload_byte_length" is null) or ("raw_events"."payload_sha256" is not null and "raw_events"."payload_ref" is not null and "raw_events"."payload_byte_length" >= 0))
);
--> statement-breakpoint
CREATE TABLE "revision_edge_members" (
	"revision_id" uuid NOT NULL,
	"logical_edge_id" uuid NOT NULL,
	"edge_version_id" uuid NOT NULL,
	CONSTRAINT "revision_edge_members_revision_id_logical_edge_id_pk" PRIMARY KEY("revision_id","logical_edge_id")
);
--> statement-breakpoint
CREATE TABLE "revision_node_members" (
	"revision_id" uuid NOT NULL,
	"logical_node_id" uuid NOT NULL,
	"node_version_id" uuid NOT NULL,
	CONSTRAINT "revision_node_members_revision_id_logical_node_id_pk" PRIMARY KEY("revision_id","logical_node_id")
);
--> statement-breakpoint
CREATE TABLE "semantic_edge_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_edge_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"source_node_id" uuid NOT NULL,
	"target_node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "semantic_edges_no_self_edge" CHECK ("semantic_edge_versions"."source_node_id" <> "semantic_edge_versions"."target_node_id")
);
--> statement-breakpoint
CREATE TABLE "semantic_node_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_node_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"primary_parent_id" uuid,
	"primary_agent_id" text,
	"participant_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pinned_by_human" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "semantic_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"parent_revision_id" uuid,
	"branch_kind" "semantic_branch_kind" NOT NULL,
	"branch_sequence" integer NOT NULL,
	"event_watermark" bigint NOT NULL,
	"source_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "semantic_revisions_branch_sequence_nonnegative" CHECK ("semantic_revisions"."branch_sequence" >= 0),
	CONSTRAINT "semantic_revisions_event_watermark_nonnegative" CHECK ("semantic_revisions"."event_watermark" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stream_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trace_id" uuid NOT NULL,
	"revision_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "summary_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"job_nonce" uuid NOT NULL,
	"input_hash" char(64) NOT NULL,
	"prompt_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"status" "summary_job_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summary_jobs_job_nonce_unique" UNIQUE("job_nonce"),
	CONSTRAINT "summary_jobs_attempt_count_nonnegative" CHECK ("summary_jobs"."attempt_count" >= 0),
	CONSTRAINT "summary_jobs_input_hash_format" CHECK ("summary_jobs"."input_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "trace_status" DEFAULT 'active' NOT NULL,
	"next_ingest_seq" bigint DEFAULT 1 NOT NULL,
	"completion_watermark" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traces_next_ingest_seq_positive" CHECK ("traces"."next_ingest_seq" > 0),
	CONSTRAINT "traces_completion_watermark_nonnegative" CHECK ("traces"."completion_watermark" is null or "traces"."completion_watermark" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_node_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."node_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_event_id_raw_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."raw_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_claims" ADD CONSTRAINT "node_claims_node_version_id_semantic_node_versions_id_fk" FOREIGN KEY ("node_version_id") REFERENCES "public"."semantic_node_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_feedback" ADD CONSTRAINT "node_feedback_node_version_id_semantic_node_versions_id_fk" FOREIGN KEY ("node_version_id") REFERENCES "public"."semantic_node_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_summary_job_id_summary_jobs_id_fk" FOREIGN KEY ("summary_job_id") REFERENCES "public"."summary_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_events" ADD CONSTRAINT "raw_events_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_edge_members" ADD CONSTRAINT "revision_edge_members_revision_id_semantic_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."semantic_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_edge_members" ADD CONSTRAINT "revision_edge_members_edge_version_id_semantic_edge_versions_id_fk" FOREIGN KEY ("edge_version_id") REFERENCES "public"."semantic_edge_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_node_members" ADD CONSTRAINT "revision_node_members_revision_id_semantic_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."semantic_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_node_members" ADD CONSTRAINT "revision_node_members_node_version_id_semantic_node_versions_id_fk" FOREIGN KEY ("node_version_id") REFERENCES "public"."semantic_node_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_edge_versions" ADD CONSTRAINT "semantic_edge_versions_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_node_versions" ADD CONSTRAINT "semantic_node_versions_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_revisions" ADD CONSTRAINT "semantic_revisions_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_events" ADD CONSTRAINT "stream_events_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "summary_jobs" ADD CONSTRAINT "summary_jobs_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_trace_source_uidx" ON "agents" USING btree ("trace_id","source_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_trace_hash_uidx" ON "artifacts" USING btree ("trace_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_checkpoint_source_uidx" ON "collector_checkpoints" USING btree ("source_kind","source_identity");--> statement-breakpoint
CREATE INDEX "idempotency_expiry_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "node_claims_version_ordinal_uidx" ON "node_claims" USING btree ("node_version_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_slug_uidx" ON "projects" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_events_trace_seq_uidx" ON "raw_events" USING btree ("trace_id","ingest_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_events_source_identity_uidx" ON "raw_events" USING btree ("trace_id","source_kind","source_instance_id","source_event_id");--> statement-breakpoint
CREATE INDEX "raw_events_trace_time_idx" ON "raw_events" USING btree ("trace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "raw_events_trace_agent_idx" ON "raw_events" USING btree ("trace_id","agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "semantic_edge_versions_trace_logical_idx" ON "semantic_edge_versions" USING btree ("trace_id","logical_edge_id");--> statement-breakpoint
CREATE INDEX "semantic_node_versions_trace_logical_idx" ON "semantic_node_versions" USING btree ("trace_id","logical_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_revisions_trace_branch_seq_uidx" ON "semantic_revisions" USING btree ("trace_id","branch_kind","branch_sequence");--> statement-breakpoint
CREATE INDEX "semantic_revisions_trace_watermark_idx" ON "semantic_revisions" USING btree ("trace_id","event_watermark");--> statement-breakpoint
CREATE INDEX "stream_events_trace_id_idx" ON "stream_events" USING btree ("trace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "summary_jobs_trace_input_uidx" ON "summary_jobs" USING btree ("trace_id","input_hash");--> statement-breakpoint
CREATE INDEX "summary_jobs_status_attempt_idx" ON "summary_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "traces_project_created_idx" ON "traces" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE FUNCTION intenttrace_reject_immutable_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IntentTrace immutable table % cannot be updated', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER raw_events_immutable BEFORE UPDATE ON raw_events
FOR EACH ROW EXECUTE FUNCTION intenttrace_reject_immutable_update();
--> statement-breakpoint
CREATE TRIGGER semantic_revisions_immutable BEFORE UPDATE ON semantic_revisions
FOR EACH ROW EXECUTE FUNCTION intenttrace_reject_immutable_update();
--> statement-breakpoint
CREATE TRIGGER semantic_node_versions_immutable BEFORE UPDATE ON semantic_node_versions
FOR EACH ROW EXECUTE FUNCTION intenttrace_reject_immutable_update();
--> statement-breakpoint
CREATE TRIGGER semantic_edge_versions_immutable BEFORE UPDATE ON semantic_edge_versions
FOR EACH ROW EXECUTE FUNCTION intenttrace_reject_immutable_update();
--> statement-breakpoint
CREATE TRIGGER node_claims_immutable BEFORE UPDATE ON node_claims
FOR EACH ROW EXECUTE FUNCTION intenttrace_reject_immutable_update();
--> statement-breakpoint
CREATE TRIGGER revision_node_members_immutable BEFORE UPDATE ON revision_node_members
FOR EACH ROW EXECUTE FUNCTION intenttrace_reject_immutable_update();
--> statement-breakpoint
CREATE TRIGGER revision_edge_members_immutable BEFORE UPDATE ON revision_edge_members
FOR EACH ROW EXECUTE FUNCTION intenttrace_reject_immutable_update();
--> statement-breakpoint
CREATE TRIGGER claim_evidence_immutable BEFORE UPDATE ON claim_evidence
FOR EACH ROW EXECUTE FUNCTION intenttrace_reject_immutable_update();
