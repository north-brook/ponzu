import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import * as schema from "../schema/index.ts";
import { githubUserTokens, repoSecrets } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { saveGithubUserToken } from "./github-tokens.ts";
import {
  countSealedValues,
  listSealedNotUnder,
  replaceSealedValue,
  SEALED_COLUMNS,
  type SealedColumn,
} from "./sealed.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const OLD = "aaaaaaaa";
const NEW = "bbbbbbbb";
const sealedAs = (keyId: string, tag: string) => `pzv1.${keyId}.nonce${tag}.cipher${tag}`;
const spec = (binding: string) => SEALED_COLUMNS.find((column) => column.binding === binding)!;
const secrets = spec("repo_secrets.encrypted_value");
const access = spec("github_user_tokens.access_token");
const refresh = spec("github_user_tokens.refresh_token");

describe("SEALED_COLUMNS", () => {
  const tables = (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableConfig(table));

  test("names every encrypted column in the schema, so a rotation leaves none behind", () => {
    const encrypted = tables.flatMap((table) =>
      table.columns
        .filter((column) => column.name.startsWith("encrypted_"))
        .map((column) => `${table.name}.${column.name}`),
    );
    expect(encrypted.sort()).toEqual(
      SEALED_COLUMNS.map(({ table, column }) => `${table}.${column}`).sort(),
    );
  });

  test("keys each column by its table's primary key, in order", () => {
    for (const { table, keys } of SEALED_COLUMNS) {
      const config = tables.find((candidate) => candidate.name === table)!;
      const primary = [
        ...config.columns.filter((column) => column.primary).map((column) => column.name),
        ...config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
      ];
      expect([table, ...primary]).toEqual([table, ...keys]);
    }
  });
});

describe("the sealed-value statements", () => {
  test("list what another key sealed, a page at a time in key order, and skip nulls", async () => {
    const workspace = await seedWorkspace(db, "sealed-pages");
    const repo = await seedRepo(db, workspace.id, "north-brook/sealed-pages");
    await db.insert(repoSecrets).values([
      { repoId: repo.id, name: "C", encryptedValue: sealedAs(OLD, "c") },
      { repoId: repo.id, name: "A", encryptedValue: sealedAs(OLD, "a") },
      { repoId: repo.id, name: "B", encryptedValue: sealedAs(NEW, "b") },
      { repoId: repo.id, name: "D", encryptedValue: "not a vault value" },
    ]);
    const mine = <T extends { row: string }>(page: T[]) =>
      page.filter(({ row }) => row.startsWith(repo.id));

    const first = mine(
      await listSealedNotUnder(db, secrets, {
        currentKeyId: NEW,
        after: [repo.id, ""],
        limit: 2,
      }),
    );
    expect(first.map(({ keys, row }) => [keys, row])).toEqual([
      [[repo.id, "A"], `${repo.id}/A`],
      [[repo.id, "C"], `${repo.id}/C`],
    ]);
    expect(first[0]!.sealed).toBe(sealedAs(OLD, "a"));
    const second = await listSealedNotUnder(db, secrets, {
      currentKeyId: NEW,
      after: first.at(-1)!.keys,
      limit: 2,
    });
    expect(mine(second).map(({ row }) => row)).toEqual([`${repo.id}/D`]);

    const user = await seedUser(db, "sealed-null");
    await saveGithubUserToken(db, {
      userId: user.id,
      encryptedAccessToken: sealedAs(OLD, "access"),
      accessTokenExpiresAt: null,
      encryptedRefreshToken: null,
      refreshTokenExpiresAt: null,
    });
    const refreshes = await listSealedNotUnder(db, refresh, {
      currentKeyId: NEW,
      after: null,
      limit: 100,
    });
    expect(refreshes.some(({ row }) => row === user.id)).toBe(false);
    const accesses = await listSealedNotUnder(db, access, {
      currentKeyId: NEW,
      after: null,
      limit: 100,
    });
    expect(accesses.find(({ row }) => row === user.id)?.sealed).toBe(sealedAs(OLD, "access"));
  });

  test("replace a value only while the row still holds the one that was read", async () => {
    const user = await seedUser(db, "sealed-replace");
    await saveGithubUserToken(db, {
      userId: user.id,
      encryptedAccessToken: sealedAs(OLD, "1"),
      accessTokenExpiresAt: null,
      encryptedRefreshToken: sealedAs(OLD, "r"),
      refreshTokenExpiresAt: null,
    });
    const stored = () =>
      db.select().from(githubUserTokens).where(eq(githubUserTokens.userId, user.id));
    const [before] = await stored();

    expect(
      await replaceSealedValue(db, access, {
        keys: [user.id],
        previous: sealedAs(OLD, "1"),
        next: sealedAs(NEW, "1"),
      }),
    ).toBe(true);
    // A second try from the same read finds the row changed and leaves it.
    expect(
      await replaceSealedValue(db, access, {
        keys: [user.id],
        previous: sealedAs(OLD, "1"),
        next: sealedAs(NEW, "stale"),
      }),
    ).toBe(false);
    const [after] = await stored();
    expect(after!.encryptedAccessToken).toBe(sealedAs(NEW, "1"));
    // The other sealed column of the row, and its updated_at, are untouched.
    expect(after!.encryptedRefreshToken).toBe(sealedAs(OLD, "r"));
    expect(after!.updatedAt).toEqual(before!.updatedAt);
    expect(
      await replaceSealedValue(db, access, {
        keys: ["usr_nobody"],
        previous: sealedAs(OLD, "1"),
        next: sealedAs(NEW, "1"),
      }),
    ).toBe(false);
  });

  test("count sealed values per column and key id", async () => {
    const counts = await countSealedValues(db);
    const of = (binding: string, keyId: string) =>
      counts.find((count) => count.binding === binding && count.keyId === keyId)?.count ?? 0;
    expect(of("github_user_tokens.access_token", NEW)).toBe(1);
    expect(of("github_user_tokens.access_token", OLD)).toBe(1);
    expect(of("github_user_tokens.refresh_token", OLD)).toBe(1);
    expect(of("repo_secrets.encrypted_value", OLD)).toBe(2);
    expect(of("repo_secrets.encrypted_value", NEW)).toBe(1);
    // A malformed value counts under whatever sits where a key id would.
    expect(of("repo_secrets.encrypted_value", "")).toBe(1);
    expect(counts.every(({ count }) => count > 0)).toBe(true);
  });

  test("refuse a key id that is not 8 hex characters, and keys that do not fit", async () => {
    const bad: SealedColumn = secrets;
    for (const currentKeyId of ["", "aaaa%", "AAAAAAAA", "aaaaaaaa_"]) {
      await expect(
        listSealedNotUnder(db, bad, { currentKeyId, after: null, limit: 1 }),
      ).rejects.toThrow(/8 hex/);
    }
    await expect(
      replaceSealedValue(db, secrets, { keys: ["one"], previous: "a", next: "b" }),
    ).rejects.toThrow(/do not fit/);
  });
});
