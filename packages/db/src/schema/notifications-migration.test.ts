// The notifications migration on a database that has rows from before it: the hand-written lines
// that forget the old APNs devices have to run before the new check and key, or it would fail.
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
const TAG = tags.find((tag) => /^\d{4}_notifications$/.test(tag))!;

async function apply(client: PGlite, tag: string) {
  const text = readFileSync(join(migrationsFolder, `${tag}.sql`), "utf8");
  for (const statement of text.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
}

let client: PGlite;
beforeAll(async () => {
  client = await createEmptyTestDb();
  for (const tag of tags.slice(0, tags.indexOf(TAG))) await apply(client, tag);
});
afterAll(() => client.close());

test("is in the journal", () => {
  expect(TAG).toBeDefined();
});

test("forgets the APNs devices from before, keeps one row an install, then holds the new rules", async () => {
  await client.exec(`
    insert into users (id, workos_user_id, github_user_id, github_login)
    values ('usr_a', 'user_a', 1, 'maya'), ('usr_b', 'user_b', 2, 'ines');
    insert into devices (id, user_id, platform, push_token, push_environment, install_id, last_seen_at)
    values
      -- An iPhone with an APNs token in hex: nothing was ever sent to it.
      ('dev_hex', 'usr_a', 'ios', '${"ab".repeat(32)}', 'production', 'install-aaaaaaaaaaaa', now()),
      -- A Mac that registered a token under the old contract.
      ('dev_mac', 'usr_a', 'macos', '${"cd".repeat(32)}', 'production', 'install-bbbbbbbbbbbb', now()),
      -- Two rows of one install, which the old contract allowed; the one seen last stays.
      ('dev_old', 'usr_b', 'ios', 'ExponentPushToken[old-token-1]', 'production', 'install-cccccccccccc', now() - interval '1 day'),
      ('dev_new', 'usr_b', 'ios', 'ExponentPushToken[new-token-1]', 'production', 'install-cccccccccccc', now()),
      ('dev_none', 'usr_b', 'ios', 'ExpoPushToken[no-install-1]', 'development', null, now());
  `);

  await apply(client, TAG);

  const { rows } = await client.query<{ id: string }>("select id from devices order by id");
  expect(rows.map((row) => row.id)).toEqual(["dev_new", "dev_none"]);

  // A Mac now registers with no token, and an iPhone may not.
  await client.exec(`
    insert into devices (id, user_id, platform, install_id) values ('dev_studio', 'usr_a', 'macos', 'install-dddddddddddd');
  `);
  await expect(
    client.exec(
      `insert into devices (id, user_id, platform, install_id) values ('dev_bad', 'usr_a', 'ios', 'install-eeeeeeeeeeee')`,
    ),
  ).rejects.toThrow("devices_push_token_check");
  // One row a person and install.
  await expect(
    client.exec(
      `insert into devices (id, user_id, platform, install_id) values ('dev_twice', 'usr_a', 'macos', 'install-dddddddddddd')`,
    ),
  ).rejects.toThrow("devices_user_install_key");
});
