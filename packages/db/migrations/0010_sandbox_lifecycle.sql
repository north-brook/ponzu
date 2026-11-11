ALTER TABLE "sandboxes" DROP CONSTRAINT "sandboxes_state_check";--> statement-breakpoint
-- `starting` is now `waking`. Nothing deployed before this wrote a sandbox, but say so anyway.
UPDATE "sandboxes" SET "state" = 'waking' WHERE "state" = 'starting';--> statement-breakpoint
ALTER TABLE "claude_accounts" ALTER COLUMN "encrypted_credential" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ALTER COLUMN "provider_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ALTER COLUMN "state" SET DEFAULT 'waking';--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN "agent_blocker" text;--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN "create_key" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "state_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "failure" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "runner_token_id" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "claude_credential" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "awake_user_id" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "auto_stop_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "restarts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_runner_token_id_runner_tokens_id_fk" FOREIGN KEY ("runner_token_id") REFERENCES "public"."runner_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_awake_user_id_users_id_fk" FOREIGN KEY ("awake_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "designs_owner_id_create_key_key" ON "designs" USING btree ("owner_id","create_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_design_id_generation_key" ON "sandboxes" USING btree ("design_id","generation");--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD CONSTRAINT "claude_accounts_credential_check" CHECK (("claude_accounts"."status" = 'revoked') = ("claude_accounts"."encrypted_credential" is null));--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_agent_blocker_check" CHECK ("designs"."agent_blocker" in ('claude_not_connected', 'claude_expired', 'sandbox_busy', 'sandbox_failed'));--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_generation_check" CHECK ("sandboxes"."generation" > 0);--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_state_check" CHECK ("sandboxes"."state" in ('waking', 'awake', 'stopping', 'asleep', 'failed', 'gone'));