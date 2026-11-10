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
CREATE INDEX "repo_access_repo_id_idx" ON "repo_access" USING btree ("repo_id");