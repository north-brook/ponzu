-- Boat goes away entirely (docs/cloud.md, "The sandbox"). An existing design has no sandbox row
-- after this: its next wake creates pz-<scope>-<designId> at Vercel, and its runner, finding no
-- disk, restores from git and the last checkpoint.
--
-- What was awake is metered up to now, under the old usage ids, before its rows go.
INSERT INTO "usage_events" ("id", "workspace_id", "design_id", "user_id", "kind", "seconds", "payer", "rate_card_version", "occurred_at")
SELECT s."id" || '/' || floor(extract(epoch from s."awake_since") * 1000)::bigint,
       d."workspace_id", d."id", s."awake_user_id", 'sandbox',
       greatest(0, round(extract(epoch from (now() - s."awake_since"))))::int,
       'ponzu',
       coalesce(
         (select max("version") from "rate_cards" where "effective_from" <= s."awake_since"),
         (select min("version") from "rate_cards")
       ),
       s."awake_since"
  FROM "sandboxes" s JOIN "designs" d ON d."id" = s."design_id"
 WHERE s."state" = 'awake' AND s."awake_since" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Every runner out there is boat's: its next call gets 401 and it exits 78.
UPDATE "runner_tokens" SET "revoked_at" = now() WHERE "revoked_at" IS NULL;--> statement-breakpoint
-- A sign-in under way has a boat sandbox behind it: it is over, and the person starts again.
UPDATE "auth_states" SET "consumed_at" = now() WHERE "kind" = 'claude_sign_in' AND "consumed_at" IS NULL;--> statement-breakpoint
DELETE FROM "webhook_deliveries" WHERE "source" = 'boat';--> statement-breakpoint
ALTER TABLE "designs" DROP CONSTRAINT "designs_sandbox_id_sandboxes_id_fk";--> statement-breakpoint
DROP INDEX "designs_sandbox_id_idx";--> statement-breakpoint
ALTER TABLE "designs" DROP COLUMN "sandbox_id";--> statement-breakpoint
ALTER TABLE "design_runners" DROP COLUMN "quiesced_for";--> statement-breakpoint
DROP TABLE "sandboxes";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_source_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_source_check" CHECK ("webhook_deliveries"."source" in ('github', 'stripe', 'workos'));--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"design_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"state_at" timestamp with time zone DEFAULT now() NOT NULL,
	"waking_by" text,
	"failure" text,
	"session_id" text,
	"session_started_at" timestamp with time zone,
	"address" text,
	"encrypted_port_token" text,
	"expires_at" timestamp with time zone,
	"image" text,
	"runner_token_id" text,
	"claude_credential" text,
	"awake_since" timestamp with time zone,
	"awake_user_id" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restarts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_state_check" CHECK ("sandboxes"."state" in ('asleep', 'waking', 'awake', 'stopping')),
	CONSTRAINT "sandboxes_awake_since_check" CHECK (("sandboxes"."state" = 'awake') = ("sandboxes"."awake_since" is not null))
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_runner_token_id_runner_tokens_id_fk" FOREIGN KEY ("runner_token_id") REFERENCES "public"."runner_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_awake_user_id_users_id_fk" FOREIGN KEY ("awake_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandboxes_awake_last_activity_at_idx" ON "sandboxes" USING btree ("last_activity_at") WHERE "sandboxes"."state" = 'awake';