// Start every workspace's people-joined window now (docs/cloud.md, "Email"), so that when the
// `team` email is first released in an environment only the people who join from then on are
// announced, and nobody who joined while it was off or paused.
//
// Run it once, just before removing `team` from PONZU_EMAIL_PAUSED (docs/production.md, "Email
// (Resend)"), against the environment's database:
//
//   DATABASE_URL=… bun apps/api/scripts/email-stamp-members.ts
//
// It only ever moves a window's start later (to now), never earlier, so running it again is
// safe; all it can cost is a join from the last minutes going unannounced. A people-joined job
// already waiting whose window it moves sends nothing and schedules whoever joined after now.
// DATABASE_URL is Neon's pooled URL, as the API takes it. It prints a count, never a name.
import { createDb, stampAllMembersAnnounced } from "@ponzu/db";

const { env } = process;
const args = process.argv.slice(2);
if (!env.DATABASE_URL || args.length > 0) {
  console.error("usage: DATABASE_URL=… bun apps/api/scripts/email-stamp-members.ts");
  process.exit(2);
}

const moved = await stampAllMembersAnnounced(createDb(env.DATABASE_URL), { now: new Date() });
console.log(
  `${moved} ${moved === 1 ? "workspace's" : "workspaces'"} people-joined window now starts now.`,
);
