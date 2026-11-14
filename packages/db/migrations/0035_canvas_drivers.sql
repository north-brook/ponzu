-- hand-written (the foreign keys below take SHARE ROW EXCLUSIVE on "canvases", "agent_grants" and "users", and adding the column takes ACCESS EXCLUSIVE on "canvases", until the migration commits; give up after 5 s rather than queue live writes behind a long transaction; re-paste after regenerating)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
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
ALTER TABLE "canvas_drivers" ADD CONSTRAINT "canvas_drivers_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_drivers" ADD CONSTRAINT "canvas_drivers_grant_id_agent_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."agent_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_drivers" ADD CONSTRAINT "canvas_drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canvas_drivers_seen_at_idx" ON "canvas_drivers" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "canvas_drivers_grant_id_idx" ON "canvas_drivers" USING btree ("grant_id");