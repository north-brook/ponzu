CREATE TABLE "design_runners" (
	"design_id" text PRIMARY KEY NOT NULL,
	"runner_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heard_at" timestamp with time zone NOT NULL,
	"claude_session_id" text
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" text NOT NULL,
	"design_id" text NOT NULL,
	"purpose" text NOT NULL,
	"name" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"served_key" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_design_id_id_pk" PRIMARY KEY("design_id","id"),
	CONSTRAINT "uploads_purpose_check" CHECK ("uploads"."purpose" in ('asset', 'export', 'preview')),
	CONSTRAINT "uploads_size_check" CHECK ("uploads"."size" >= 0),
	CONSTRAINT "uploads_completed_check" CHECK (("uploads"."completed_at" is null) = ("uploads"."served_key" is null))
);
--> statement-breakpoint
-- 0006 kept member_repos for the build before it, which is no longer deployed.
DROP TABLE "member_repos" CASCADE;--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_kind_check";--> statement-breakpoint
-- A runner chooses its thread items' and questions' ids, so they are keyed by design: the same
-- id in another design is another row.
ALTER TABLE "questions" DROP CONSTRAINT "questions_pkey";--> statement-breakpoint
ALTER TABLE "thread_items" DROP CONSTRAINT "thread_items_pkey";--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_design_id_id_pk" PRIMARY KEY("design_id","id");--> statement-breakpoint
ALTER TABLE "thread_items" ADD CONSTRAINT "thread_items_design_id_id_pk" PRIMARY KEY("design_id","id");--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "design_runners" ADD CONSTRAINT "design_runners_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The Claude session is the design's (design_runners); nothing read it here.
ALTER TABLE "sandboxes" DROP COLUMN "claude_session_id";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_kind_check" CHECK ("events"."kind" in ('message', 'answer', 'comment', 'edit', 'check', 'review', 'stop'));
