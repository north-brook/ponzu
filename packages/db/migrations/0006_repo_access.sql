CREATE TABLE "repo_access" (
	"user_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"permission" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "repo_access_user_id_repo_id_pk" PRIMARY KEY("user_id","repo_id"),
	CONSTRAINT "repo_access_permission_check" CHECK ("repo_access"."permission" in ('admin', 'write', 'read', 'none'))
);
--> statement-breakpoint
ALTER TABLE "repo_access" ADD CONSTRAINT "repo_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_access" ADD CONSTRAINT "repo_access_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_access_repo_id_idx" ON "repo_access" USING btree ("repo_id");--> statement-breakpoint
-- What member_repos knew, as answers from each member's last sync. member_repos stays for the
-- build before this one; the next migration drops it.
INSERT INTO "repo_access" ("user_id", "repo_id", "permission", "checked_at")
SELECT "member_repos"."user_id", "member_repos"."repo_id",
       CASE WHEN "member_repos"."can_push" THEN 'write' ELSE 'read' END,
       "memberships"."synced_at"
  FROM "member_repos"
  JOIN "memberships"
    ON "memberships"."workspace_id" = "member_repos"."workspace_id"
   AND "memberships"."user_id" = "member_repos"."user_id"
ON CONFLICT DO NOTHING;