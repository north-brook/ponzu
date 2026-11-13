-- hand-written (the foreign keys below take SHARE ROW EXCLUSIVE on "canvases" until the migration commits, which holds every write to it; give up after 5 s rather than queue live writes behind a long transaction; re-paste after regenerating)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- hand-written (drizzle-kit does not emit extensions, and the trigram index below needs pg_trgm; re-paste after regenerating)
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "search_entries" (
	"canvas_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"text" text NOT NULL,
	"folded" text NOT NULL,
	"context" jsonb NOT NULL,
	"author_kind" text,
	"author_id" text,
	"author_name" text,
	"at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_entries_canvas_id_kind_ref_pk" PRIMARY KEY("canvas_id","kind","ref")
);
--> statement-breakpoint
CREATE TABLE "search_state" (
	"canvas_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"indexed_seq" bigint NOT NULL,
	"indexed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_entries" ADD CONSTRAINT "search_entries_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_state" ADD CONSTRAINT "search_state_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_entries_folded_trgm_idx" ON "search_entries" USING gin ("folded" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "search_entries_names_trgm_idx" ON "search_entries" USING gin ("folded" gin_trgm_ops) WHERE "search_entries"."kind" in ('canvas', 'page', 'board', 'pull_request');