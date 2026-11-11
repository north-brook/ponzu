ALTER TABLE "designs" DROP CONSTRAINT "designs_agent_blocker_check";--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "waking_by" text;--> statement-breakpoint
-- One open Claude sign-in a person: close all but the newest of any they have open now.
UPDATE "auth_states" SET "consumed_at" = now()
 WHERE "kind" = 'claude_sign_in' AND "consumed_at" IS NULL
   AND "id" NOT IN (
     SELECT DISTINCT ON ("user_id") "id" FROM "auth_states"
      WHERE "kind" = 'claude_sign_in' AND "consumed_at" IS NULL
      ORDER BY "user_id", "created_at" DESC
   );--> statement-breakpoint
CREATE UNIQUE INDEX "auth_states_open_claude_sign_in_key" ON "auth_states" USING btree ("user_id") WHERE "auth_states"."kind" = 'claude_sign_in' and "auth_states"."consumed_at" is null;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_agent_blocker_check" CHECK ("designs"."agent_blocker" in ('claude_not_connected', 'claude_expired', 'claude_owner_left', 'sandbox_busy', 'sandbox_failed'));
