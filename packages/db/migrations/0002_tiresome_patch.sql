ALTER TABLE "summary_jobs" ADD COLUMN "event_watermark" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "summary_jobs" ADD COLUMN "branch_kind" "semantic_branch_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "summary_jobs" ADD CONSTRAINT "summary_jobs_event_watermark_nonnegative" CHECK ("summary_jobs"."event_watermark" >= 0);