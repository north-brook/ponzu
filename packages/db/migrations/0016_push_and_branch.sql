ALTER TABLE "events" DROP CONSTRAINT "events_kind_check";--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "unpushed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "design_runners" ADD COLUMN "push_error" text;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_kind_check" CHECK ("events"."kind" in ('message', 'answer', 'comment', 'edit', 'check', 'review', 'stop', 'push'));