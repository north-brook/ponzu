ALTER TABLE "users" ALTER COLUMN "ping_teammate_comments" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "install_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "pings_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_secrets" ADD COLUMN "value_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "base_rebuild_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repo_secrets" ADD CONSTRAINT "repo_secrets_value_bytes_check" CHECK ("repo_secrets"."value_bytes" >= 0);--> statement-breakpoint
-- Nobody could set "A teammate comments" before this migration, so every row holds the old
-- default rather than a choice: it starts off, as the Notifications board draws it.
UPDATE "users" SET "ping_teammate_comments" = false;
