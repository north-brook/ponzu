// The billing migration on a database that has rows from before it, and what the API released
// before it (still running for the minutes between the migration and the new deploy) writes
// after it: every statement of that API's shape must still work, because the migration only adds.
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
const TAG = tags.find((tag) => /^\d{4}_billing$/.test(tag))!;
const text = () => readFileSync(join(migrationsFolder, `${TAG}.sql`), "utf8");

async function apply(client: PGlite, tag: string) {
  const sql = readFileSync(join(migrationsFolder, `${tag}.sql`), "utf8");
  // As migrate.ts applies it: inside one transaction, which `SET LOCAL` needs.
  await client.exec("begin");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
  await client.exec("commit");
}

let client: PGlite;
beforeAll(async () => {
  client = await createEmptyTestDb();
  await client.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  for (const tag of tags.slice(0, tags.indexOf(TAG))) await apply(client, tag);
});
afterAll(() => client.close());

test("is in the journal, and is the newest migration", () => {
  expect(TAG).toBeDefined();
  expect(tags.at(-1)).toBe(TAG);
});

test("gives up on a lock after five seconds rather than queue live requests", () => {
  const first = text()
    .split("--> statement-breakpoint")
    .map((statement) =>
      statement
        .split("\n")
        .filter((line) => line.trim() && !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .find(Boolean);
  expect(first).toBe("SET LOCAL lock_timeout = '5s';");
});

test("only adds: no drop of a column or table, no rename, no type change", () => {
  const statements = text().split("--> statement-breakpoint");
  for (const statement of statements) {
    expect(statement).not.toMatch(/DROP (TABLE|COLUMN|INDEX)|RENAME|ALTER COLUMN|SET NOT NULL/i);
  }
  // The one constraint it drops is the auth state kinds' check, put back at once with one more kind.
  const dropped = statements.filter((statement) => /DROP CONSTRAINT/.test(statement));
  expect(dropped.map((statement) => statement.trim())).toEqual([
    'ALTER TABLE "auth_states" DROP CONSTRAINT "auth_states_kind_check";',
  ]);
  expect(text()).toContain(
    `ALTER TABLE "auth_states" ADD CONSTRAINT "auth_states_kind_check" CHECK ("auth_states"."kind" in ('github_install', 'claude_sign_in', 'card_setup'));`,
  );
});

test("keeps every row from before, and the released API's writes still work after it", async () => {
  await client.exec(`
    insert into users (id, workos_user_id, github_user_id, github_login)
    values ('usr_a', 'user_a', 1, 'maya');
    insert into workspaces (id, github_account_id, github_login, kind, name, monthly_cap_cents,
                            card_brand, card_last4)
    values ('ws_old', 10, 'north-brook', 'org', 'North Brook', 5000, null, null);
    insert into auth_states (id, kind, user_id, payload, expires_at)
    values ('auth_install', 'github_install', 'usr_a', '{"client":"mac"}', now() + interval '15 minutes'),
           ('auth_signin', 'claude_sign_in', 'usr_a', '{}', now() + interval '15 minutes');
  `);

  await apply(client, TAG);

  // The rows from before get the new columns' defaults: an ok gate, no card, nothing planned.
  const { rows } = await client.query<Record<string, unknown>>(
    `select monthly_cap_cents, billing_gate, billing_gate_at, billing_next_close_at,
            stripe_payment_method_id, card_added_at, card_added_by_user_id, past_due_reason,
            past_due_invoice_url
       from workspaces where id = 'ws_old'`,
  );
  expect(rows).toEqual([
    {
      monthly_cap_cents: 5000,
      billing_gate: "ok",
      billing_gate_at: null,
      billing_next_close_at: null,
      stripe_payment_method_id: null,
      card_added_at: null,
      card_added_by_user_id: null,
      past_due_reason: null,
      past_due_invoice_url: null,
    },
  ]);

  // The released API names only the columns it knows. Each of its writes still goes in.
  await client.exec(`
    insert into workspaces (id, github_account_id, github_login, kind, name, avatar_url,
                            installation_id, repository_selection, installed_by_user_id, installed_at)
    values ('ws_new', 11, 'ponzu', 'personal', 'Ponzu', null, 99, 'all', 'usr_a', now());
    update workspaces set monthly_cap_cents = 20000 where id = 'ws_old';
    update workspaces set suspended_at = now(), reconciled_at = now() where installation_id = 99;
    insert into auth_states (id, kind, user_id, payload, expires_at)
    values ('auth_install_2', 'github_install', 'usr_a', '{}', now() + interval '15 minutes');
    update auth_states set consumed_at = now() where id = 'auth_signin';
    insert into auth_states (id, kind, user_id, payload, expires_at)
    values ('auth_signin_2', 'claude_sign_in', 'usr_a', '{}', now() + interval '15 minutes');
  `);
  const fresh = await client.query<{ billing_gate: string }>(
    "select billing_gate from workspaces where id = 'ws_new'",
  );
  expect(fresh.rows).toEqual([{ billing_gate: "ok" }]);
  // A person still has one Claude sign-in open at a time.
  await expect(
    client.exec(`
      insert into auth_states (id, kind, user_id, payload, expires_at)
      values ('auth_signin_3', 'claude_sign_in', 'usr_a', '{}', now() + interval '15 minutes')`),
  ).rejects.toThrow("auth_states_open_claude_sign_in_key");
  // A kind no API knows is still refused.
  await expect(
    client.exec(`
      insert into auth_states (id, kind, user_id, payload, expires_at)
      values ('auth_other', 'card', 'usr_a', '{}', now())`),
  ).rejects.toThrow("auth_states_kind_check");
});

test("holds one open card setup per workspace, and nothing else to it", async () => {
  const setup = (id: string, workspace: string) =>
    client.exec(`
      insert into auth_states (id, kind, user_id, payload, expires_at)
      values ('${id}', 'card_setup', 'usr_a', '{"workspaceId":"${workspace}"}', now() + interval '35 minutes')`);
  await setup("auth_card_1", "ws_old");
  await setup("auth_card_2", "ws_new");
  await expect(setup("auth_card_3", "ws_old")).rejects.toThrow("auth_states_open_card_setup_key");
  await client.exec("update auth_states set consumed_at = now() where id = 'auth_card_1'");
  await setup("auth_card_3", "ws_old");
});
