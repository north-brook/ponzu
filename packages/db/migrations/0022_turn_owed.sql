ALTER TABLE "design_runners" ADD COLUMN "said_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "lapsed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "events_design_id_delivered_at_idx" ON "events" USING btree ("design_id","delivered_at");--> statement-breakpoint
-- What was delivered before this migration is not owed a turn: nothing watched for one then.
UPDATE "design_runners" SET "said_at" = now();
