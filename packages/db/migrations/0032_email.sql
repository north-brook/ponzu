-- hand-written (each ALTER TABLE below takes an ACCESS EXCLUSIVE lock on "users", "workspaces" or "notifications" for as long as the migration's transaction runs; the columns are added without a rewrite (constant or stable defaults), so give up after 5 s rather than queue live reads and writes behind a long transaction; re-paste after regenerating)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "email_notices" (
	"notice_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"address" text,
	"sent_at" timestamp with time zone,
	"resend_id" text,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_notices_notice_id_user_id_pk" PRIMARY KEY("notice_id","user_id"),
	CONSTRAINT "email_notices_outcome_check" CHECK ("email_notices"."outcome" in ('pending', 'sent', 'refused', 'no_address', 'held'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_team" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_recap" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recap_sent_on" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recap_first_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "members_announced_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "emailed_at" timestamp with time zone;