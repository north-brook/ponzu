ALTER TABLE "design_runners" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "saved_through" bigint;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "moving_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "image_failed" text;--> statement-breakpoint
-- A checkpoint recorded before this column covers the events delivered before it was recorded.
-- Both times are real clocks here (the API's and Postgres's), far closer than a turn is long.
UPDATE "design_runners" r SET "saved_through" = (
  SELECT max(e."seq") FROM "events" e
   WHERE e."design_id" = r."design_id" AND e."delivered_at" IS NOT NULL
     AND e."delivered_at" <= r."saved_at"
) WHERE r."saved_at" IS NOT NULL;
