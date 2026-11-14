-- hand-written (no schema change: this migration only makes kept answers stale. The UPDATE takes ROW EXCLUSIVE on "repo_access", which no other write waits on, and a row lock on each "read" row; give up after 5 s rather than queue behind a live write; re-paste after regenerating with drizzle-kit generate --custom)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- hand-written (every kept "read" answer was written under the old rule, where a public repo was "read" to anyone; stale, each is asked of GitHub again before it is trusted, and a ping counts it as no until then; re-paste after regenerating)
UPDATE "repo_access" SET "checked_at" = 'epoch' WHERE "permission" = 'read' AND "checked_at" > 'epoch';
