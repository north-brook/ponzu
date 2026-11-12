ALTER TABLE "claude_accounts" ADD COLUMN "models" jsonb;--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD COLUMN "models_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD COLUMN "models_claude_code" text;