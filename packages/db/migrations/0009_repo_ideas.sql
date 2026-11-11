ALTER TABLE "repos" ADD COLUMN "ideas_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ideas_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ideas_window_count" integer DEFAULT 0 NOT NULL;