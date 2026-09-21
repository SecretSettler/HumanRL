ALTER TABLE "raw_events" ADD COLUMN "event_hash" char(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "semantic_node_versions" ADD COLUMN "layout" jsonb;--> statement-breakpoint
ALTER TABLE "semantic_revisions" ADD COLUMN "stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_events" ADD CONSTRAINT "raw_events_event_hash_format" CHECK ("raw_events"."event_hash" ~ '^[a-f0-9]{64}$');