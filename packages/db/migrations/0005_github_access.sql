CREATE TABLE "member_repos" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"can_push" boolean NOT NULL,
	CONSTRAINT "member_repos_workspace_id_user_id_repo_id_pk" PRIMARY KEY("workspace_id","user_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "uninstalled_installations" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"uninstalled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "github_access" text DEFAULT 'collaborator' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_repos" ADD CONSTRAINT "member_repos_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_repos" ADD CONSTRAINT "member_repos_membership_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_repos_repo_id_idx" ON "member_repos" USING btree ("repo_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_github_access_check" CHECK ("memberships"."github_access" in ('owner', 'member', 'collaborator'));