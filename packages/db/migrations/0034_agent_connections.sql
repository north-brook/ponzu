-- hand-written (the foreign keys below take SHARE ROW EXCLUSIVE on "users", "canvases" and "agent_grants", and adding the column takes ACCESS EXCLUSIVE on "canvases", until the migration commits; give up after 5 s rather than queue live writes behind a long transaction; re-paste after regenerating)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "agent_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"state" text,
	"scope" text,
	"resource" text,
	"user_id" text,
	"grant_id" text,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_authorizations_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "agent_authorizations_decided_check" CHECK (not ("agent_authorizations"."approved_at" is not null and "agent_authorizations"."denied_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "agent_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"redirect_uris" text[] NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"last_client" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agent_tokens_kind_check" CHECK ("agent_tokens"."kind" in ('access', 'refresh'))
);
--> statement-breakpoint
CREATE TABLE "canvas_drivers" (
	"canvas_id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"client" text NOT NULL,
	"name" text NOT NULL,
	"host" text,
	"version" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "driver" jsonb;--> statement-breakpoint
ALTER TABLE "agent_authorizations" ADD CONSTRAINT "agent_authorizations_client_id_agent_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."agent_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_authorizations" ADD CONSTRAINT "agent_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_authorizations" ADD CONSTRAINT "agent_authorizations_grant_id_agent_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_client_id_agent_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."agent_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_grant_id_agent_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_drivers" ADD CONSTRAINT "canvas_drivers_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_drivers" ADD CONSTRAINT "canvas_drivers_grant_id_agent_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_drivers" ADD CONSTRAINT "canvas_drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_authorizations_expires_at_idx" ON "agent_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_grants_user_id_idx" ON "agent_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_tokens_grant_id_idx" ON "agent_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "agent_tokens_expires_at_idx" ON "agent_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "canvas_drivers_seen_at_idx" ON "canvas_drivers" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "canvas_drivers_grant_id_idx" ON "canvas_drivers" USING btree ("grant_id");