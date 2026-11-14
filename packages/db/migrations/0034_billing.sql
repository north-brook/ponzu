-- hand-written (the statements below take ACCESS EXCLUSIVE on "workspaces" and "auth_states" and SHARE ROW EXCLUSIVE on "users" and "rate_cards" until the migration commits, which holds every read and write of a workspace; give up after 5 s rather than queue live requests behind a long transaction; re-paste after regenerating)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "billing_periods" (
	"workspace_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'closing' NOT NULL,
	"used_credits" integer NOT NULL,
	"free_credits" integer NOT NULL,
	"billed_credits" integer NOT NULL,
	"charged_credits" integer NOT NULL,
	"charged_cents" integer NOT NULL,
	"cap_cents" integer NOT NULL,
	"people" integer NOT NULL,
	"rate_card_version" integer NOT NULL,
	"stripe_invoice_id" text,
	"invoice_number" text,
	"hosted_invoice_url" text,
	"tax_cents" integer,
	"total_cents" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoiced_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_periods_workspace_id_period_start_pk" PRIMARY KEY("workspace_id","period_start"),
	CONSTRAINT "billing_periods_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id"),
	CONSTRAINT "billing_periods_status_check" CHECK ("billing_periods"."status" in ('closing', 'unbilled', 'waived', 'invoiced', 'paid', 'payment_failed', 'uncollectible', 'void')),
	CONSTRAINT "billing_periods_span_check" CHECK ("billing_periods"."period_end" > "billing_periods"."period_start"),
	CONSTRAINT "billing_periods_numbers_check" CHECK ("billing_periods"."used_credits" >= 0 and "billing_periods"."free_credits" >= 0 and "billing_periods"."billed_credits" >= 0 and "billing_periods"."charged_credits" >= 0 and "billing_periods"."charged_credits" <= "billing_periods"."billed_credits" and "billing_periods"."charged_cents" >= 0 and "billing_periods"."charged_cents" <= "billing_periods"."cap_cents" and "billing_periods"."people" >= 0 and "billing_periods"."attempts" >= 0),
	CONSTRAINT "billing_periods_invoice_check" CHECK ("billing_periods"."status" not in ('invoiced', 'paid', 'payment_failed', 'uncollectible', 'void') or "billing_periods"."stripe_invoice_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "auth_states" DROP CONSTRAINT "auth_states_kind_check";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_gate" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_gate_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_next_close_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "stripe_payment_method_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "card_added_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "card_added_by_user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "past_due_reason" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "past_due_invoice_url" text;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_rate_card_version_rate_cards_version_fk" FOREIGN KEY ("rate_card_version") REFERENCES "public"."rate_cards"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_periods_unsettled_idx" ON "billing_periods" USING btree ("status") WHERE "billing_periods"."status" in ('invoiced', 'payment_failed');--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_card_added_by_user_id_users_id_fk" FOREIGN KEY ("card_added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_states_open_card_setup_key" ON "auth_states" USING btree (("payload" ->> 'workspaceId')) WHERE "auth_states"."kind" = 'card_setup' and "auth_states"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "workspaces_billing_next_close_at_idx" ON "workspaces" USING btree ("billing_next_close_at");--> statement-breakpoint
ALTER TABLE "auth_states" ADD CONSTRAINT "auth_states_kind_check" CHECK ("auth_states"."kind" in ('github_install', 'claude_sign_in', 'card_setup'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_billing_gate_check" CHECK ("workspaces"."billing_gate" in ('ok', 'free_used', 'cap_reached', 'payment_failed'));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_past_due_reason_check" CHECK ("workspaces"."past_due_reason" in ('failed', 'needs_confirmation'));