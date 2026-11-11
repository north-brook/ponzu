CREATE TABLE "workspace_people" (
	"workspace_id" text NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"github_access" text NOT NULL,
	"permission" text NOT NULL,
	"repo_permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_people_workspace_id_github_user_id_pk" PRIMARY KEY("workspace_id","github_user_id"),
	CONSTRAINT "workspace_people_github_access_check" CHECK ("workspace_people"."github_access" in ('owner', 'member', 'collaborator')),
	CONSTRAINT "workspace_people_permission_check" CHECK ("workspace_people"."permission" in ('admin', 'write', 'read', 'none')),
	CONSTRAINT "workspace_people_permission_not_none_check" CHECK ("workspace_people"."permission" <> 'none')
);
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "people_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "people_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "people_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_people" ADD CONSTRAINT "workspace_people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_people_github_user_id_idx" ON "workspace_people" USING btree ("github_user_id");