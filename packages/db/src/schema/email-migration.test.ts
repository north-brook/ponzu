// The email migration on a database that has rows from before it, applied as db:migrate applies
// it (one transaction): expand only, so the API deployed before it keeps working on the new
// schema, nobody already in a workspace is ever announced, and it gives up rather than queue
// behind a long lock.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { migrationsFolder } from "../migrations.ts";
import { createEmptyTestDb } from "../testing.ts";

const journal: { entries: { tag: string }[] } = JSON.parse(
  readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
);
const tags = journal.entries.map((entry) => entry.tag);
// Found by name: the number is the one free when it lands.
const TAG = tags.find((tag) => /^\d{4}_email$/.test(tag))!;
const text = () => readFileSync(join(migrationsFolder, `${TAG}.sql`), "utf8");

async function apply(client: PGlite, tag: string) {
  const sql = readFileSync(join(migrationsFolder, `${tag}.sql`), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
}

let client: PGlite;
beforeAll(async () => {
  client = await createEmptyTestDb();
  await client.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  for (const tag of tags.slice(0, tags.indexOf(TAG))) await apply(client, tag);
});
afterAll(() => client.close());

/** What the API before this migration writes: its own columns, never the new ones. */
const OLD_INSERTS = (n: number) => `
  insert into users (id, workos_user_id, github_user_id, github_login, email)
  values ('usr_${n}', 'user_${n}', ${n}, 'person${n}', 'p${n}@example.com');
  insert into workspaces (id, github_account_id, github_login, kind, name)
  values ('wks_${n}', ${1000 + n}, 'org${n}', 'org', 'Org ${n}');
  insert into notifications (id, user_id, workspace_id, kind, dedupe_key, title, body, link)
  values ('ntf_${n}', 'usr_${n}', 'wks_${n}', 'billing_free_used', 'billing:${n}', 'Org', 'Used.', '{"open":"usage"}');
`;

test("is in the journal, and sets a lock timeout before anything else", () => {
  expect(TAG).toBeDefined();
  const first = text()
    .split("\n")
    .find((line) => line.trim() && !line.startsWith("--"));
  expect(first).toBe("SET LOCAL lock_timeout = '5s';--> statement-breakpoint");
  // Expand only: nothing dropped, renamed, retyped or made required on existing data.
  expect(text()).not.toMatch(/\bDROP\b|\bRENAME\b|SET NOT NULL|ALTER COLUMN/i);
});

test("keeps the rows from before, announces none of them, and the old API's writes still go", async () => {
  await client.exec(OLD_INSERTS(1));
  // The rows were made a while before the migration.
  await client.exec(`update workspaces set created_at = now() - interval '30 days'`);

  await client.exec("begin");
  await apply(client, TAG);
  await client.exec("commit");

  const user = await client.query<Record<string, unknown>>(
    "select email_team, email_recap, recap_sent_on, recap_first_sent_at from users where id = 'usr_1'",
  );
  expect(user.rows).toEqual([
    { email_team: true, email_recap: true, recap_sent_on: null, recap_first_sent_at: null },
  ]);
  const ws = await client.query<{ fresh: boolean }>(
    "select members_announced_at > created_at + interval '29 days' as fresh from workspaces where id = 'wks_1'",
  );
  // The window starts at the migration: nobody already in the workspace is ever announced.
  expect(ws.rows).toEqual([{ fresh: true }]);
  const row = await client.query("select emailed_at from notifications where id = 'ntf_1'");
  expect(row.rows).toEqual([{ emailed_at: null }]);

  // The API deployed before the migration names only its own columns: its inserts still go.
  await client.exec(OLD_INSERTS(2));
  const made = await client.query<Record<string, unknown>>(
    "select u.email_team, u.email_recap, w.members_announced_at is not null as announced, n.emailed_at from users u, workspaces w, notifications n where u.id = 'usr_2' and w.id = 'wks_2' and n.id = 'ntf_2'",
  );
  expect(made.rows).toEqual([
    { email_team: true, email_recap: true, announced: true, emailed_at: null },
  ]);
});

test("email_notices keeps a record per notice and person, outliving the account", async () => {
  await client.exec(`
    insert into email_notices (notice_id, user_id, address, outcome)
    values ('2027-01-billing-starts', 'usr_1', 'p1@example.com', 'pending');
  `);
  // One row a notice and person.
  await expect(
    client.exec(
      `insert into email_notices (notice_id, user_id, outcome) values ('2027-01-billing-starts', 'usr_1', 'sent')`,
    ),
  ).rejects.toThrow("email_notices_notice_id_user_id_pk");
  // Only the outcomes the script writes.
  await expect(
    client.exec(
      `insert into email_notices (notice_id, user_id, outcome) values ('x', 'usr_1', 'bounced')`,
    ),
  ).rejects.toThrow("email_notices_outcome_check");
  // No foreign key: deleting the person keeps the record.
  await client.exec(
    "delete from notifications where user_id = 'usr_1'; delete from users where id = 'usr_1'",
  );
  const kept = await client.query("select outcome from email_notices where user_id = 'usr_1'");
  expect(kept.rows).toEqual([{ outcome: "pending" }]);
});
