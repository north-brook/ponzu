-- hand-written (the two ALTER TABLE ... ADD COLUMN below take an ACCESS EXCLUSIVE lock on "canvases", and the foreign keys SHARE ROW EXCLUSIVE on "canvases", "repos" and "users", until the migration commits; the columns are added without a rewrite (constant defaults), so give up after 5 s rather than queue live reads and writes behind a long transaction; re-paste after regenerating)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "canvas_pull_requests" (
	"canvas_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"checks" text DEFAULT 'none' NOT NULL,
	"mergeable" boolean,
	"auto_merge" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"source" text NOT NULL,
	"linked_by_user_id" text,
	"linked_via" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canvas_pull_requests_canvas_id_repo_id_number_pk" PRIMARY KEY("canvas_id","repo_id","number"),
	CONSTRAINT "canvas_pull_requests_state_check" CHECK ("canvas_pull_requests"."state" in ('draft', 'open', 'merged', 'closed')),
	CONSTRAINT "canvas_pull_requests_checks_check" CHECK ("canvas_pull_requests"."checks" in ('none', 'running', 'failing', 'passing')),
	CONSTRAINT "canvas_pull_requests_source_check" CHECK ("canvas_pull_requests"."source" in ('person', 'agent')),
	CONSTRAINT "canvas_pull_requests_number_check" CHECK ("canvas_pull_requests"."number" > 0),
	CONSTRAINT "canvas_pull_requests_finished_at_check" CHECK (("canvas_pull_requests"."state" in ('merged', 'closed')) = ("canvas_pull_requests"."finished_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "pr_linked_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "pr_linked_open" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "canvas_pull_requests" ADD CONSTRAINT "canvas_pull_requests_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_pull_requests" ADD CONSTRAINT "canvas_pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_pull_requests" ADD CONSTRAINT "canvas_pull_requests_linked_by_user_id_users_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canvas_pull_requests_github_repo_id_number_idx" ON "canvas_pull_requests" USING btree ("github_repo_id","number");--> statement-breakpoint
CREATE INDEX "canvas_pull_requests_open_read_at_idx" ON "canvas_pull_requests" USING btree ("read_at") WHERE "canvas_pull_requests"."finished_at" is null;