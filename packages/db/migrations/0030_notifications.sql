CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"device_id" text,
	"state" text DEFAULT 'waiting' NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"ticket_id" text,
	"receipt_checked_at" timestamp with time zone,
	"outcome" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_notification_device_key" UNIQUE("notification_id","device_id"),
	CONSTRAINT "notification_deliveries_state_check" CHECK ("notification_deliveries"."state" in ('waiting', 'sending', 'sent', 'delivered', 'cancelled', 'failed', 'unknown')),
	CONSTRAINT "notification_deliveries_sent_check" CHECK ("notification_deliveries"."state" not in ('sent', 'delivered') or ("notification_deliveries"."sent_at" is not null and "notification_deliveries"."ticket_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"canvas_id" text,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"body" text NOT NULL,
	"link" jsonb NOT NULL,
	"source_id" text,
	"count" integer DEFAULT 1 NOT NULL,
	"people" text[] DEFAULT '{}'::text[] NOT NULL,
	"merged_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"read_via" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "notifications_user_dedupe_key" UNIQUE("user_id","dedupe_key"),
	CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('needs_you', 'reply', 'finished', 'failed', 'claude_limit', 'pr_ready', 'pr_approved', 'teammate_comment', 'billing_free_used', 'billing_cap_warning', 'billing_cap_reached', 'billing_payment_failed')),
	CONSTRAINT "notifications_read_via_check" CHECK (("notifications"."read_at" is null) = ("notifications"."read_via" is null) and ("notifications"."read_via" is null or "notifications"."read_via" in ('mac', 'ios', 'seen', 'looking', 'expired'))),
	CONSTRAINT "notifications_text_check" CHECK (char_length("notifications"."title") <= 200 and char_length("notifications"."body") <= 200 and ("notifications"."subtitle" is null or char_length("notifications"."subtitle") <= 200)),
	CONSTRAINT "notifications_link_check" CHECK (jsonb_typeof("notifications"."link") = 'object' and coalesce("notifications"."link" ->> 'open', '') in ('thread', 'pull-request', 'comment', 'usage') and octet_length("notifications"."link"::text) <= 1024),
	CONSTRAINT "notifications_count_check" CHECK ("notifications"."count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "push_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "push_environment" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "digest_sent_on" date;--> statement-breakpoint
ALTER TABLE "presence" ADD COLUMN "focused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_device_id_idx" ON "notification_deliveries" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "deliveries_receipts_idx" ON "notification_deliveries" USING btree ("sent_at") WHERE "notification_deliveries"."state" = 'sent' and "notification_deliveries"."receipt_checked_at" is null;--> statement-breakpoint
CREATE INDEX "deliveries_waiting_idx" ON "notification_deliveries" USING btree ("notification_id","send_at") WHERE "notification_deliveries"."state" = 'waiting';--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" is null or ("notifications"."kind" = 'needs_you' and "notifications"."resolved_at" is null);--> statement-breakpoint
CREATE INDEX "notifications_canvas_kind_source_idx" ON "notifications" USING btree ("canvas_id","kind","source_id");--> statement-breakpoint
CREATE INDEX "notifications_workspace_id_idx" ON "notifications" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
-- hand-written (devices change contract): an iPhone now registers its Expo push token, and a Mac
-- registers with no token. A row from before holds an APNs token in hex, which nothing ever sent
-- to; the apps register again. That is every row of either platform with a token not in Expo's
-- shape. Then one row per person and install, the one seen last, in case an install registered
-- twice under the old contract (a phone whose token changed between launches).
DELETE FROM "devices" WHERE "push_token" IS NOT NULL AND "push_token" !~ '^Expo(nent)?PushToken\[';--> statement-breakpoint
DELETE FROM "devices" WHERE "platform" = 'macos' AND "push_token" IS NOT NULL;--> statement-breakpoint
DELETE FROM "devices" d USING "devices" newer
 WHERE d."install_id" IS NOT NULL AND newer."user_id" = d."user_id" AND newer."install_id" = d."install_id"
   AND (newer."last_seen_at", newer."id") > (d."last_seen_at", d."id");--> statement-breakpoint
-- end hand-written
CREATE UNIQUE INDEX "devices_user_install_key" ON "devices" USING btree ("user_id","install_id") WHERE "devices"."install_id" is not null;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_push_token_check" CHECK (("devices"."platform" = 'ios') = ("devices"."push_token" is not null));