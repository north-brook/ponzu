ALTER TABLE "uploads" DROP CONSTRAINT "uploads_purpose_check";--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "saved_turn" integer;--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "saved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "saved_claude_session_id" text;--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "saved_wip_commit" text;--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "session_upload_id" text;--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "workspace_upload_id" text;--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "quiesced_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "rollbacks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_purpose_check" CHECK ("uploads"."purpose" in ('asset', 'export', 'preview', 'session', 'workspace'));