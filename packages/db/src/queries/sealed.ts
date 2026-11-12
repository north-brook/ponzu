import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { queryJson } from "./json.ts";

/*
 * The columns that hold values the API's vault sealed, and the statements that find and replace
 * them when the vault key is rotated (apps/api/scripts/reseal.ts).
 *
 * A sealed value is `pzv1.<key id>.<nonce>.<ciphertext>` and is bound to a column and a row
 * (apps/api/src/vault/vault.ts). This package never opens one: it only reads the key id, which
 * is safe to store and to print, and swaps one sealed text for another.
 */

/** One column of sealed values. */
export interface SealedColumn {
  /** The binding's column, exactly as the API seals to it. */
  binding: string;
  table: string;
  column: string;
  /** The primary key's columns; their values joined with `/` are the binding's row. */
  keys: readonly string[];
  /**
   * A time column that, while it is in the future, means the API is rewriting the row and
   * compares its sealed text to what it read. A reseal leaves such a row alone until it passes.
   */
  busyUntil?: string;
}

/**
 * Every column the vault seals into. A new sealed column is added here, with its binding, or a
 * key rotation leaves it behind (sealed.test.ts checks the schema has no other `encrypted_`
 * column).
 */
export const SEALED_COLUMNS: readonly SealedColumn[] = [
  {
    binding: "github_user_tokens.access_token",
    table: "github_user_tokens",
    column: "encrypted_access_token",
    keys: ["user_id"],
    busyUntil: "refresh_claimed_until",
  },
  {
    binding: "github_user_tokens.refresh_token",
    table: "github_user_tokens",
    column: "encrypted_refresh_token",
    keys: ["user_id"],
    // A refresh stores GitHub's new pair only if the row still holds the sealed refresh token
    // it traded (rotateGithubUserToken). Sealing that token again mid-refresh would make the
    // store miss, and the new pair, which exists nowhere else, would be lost.
    busyUntil: "refresh_claimed_until",
  },
  {
    binding: "repo_secrets.encrypted_value",
    table: "repo_secrets",
    column: "encrypted_value",
    keys: ["repo_id", "name"],
  },
  {
    binding: "claude_accounts.encrypted_credential",
    table: "claude_accounts",
    column: "encrypted_credential",
    keys: ["id"],
  },
  {
    binding: "sandboxes.encrypted_port_token",
    table: "sandboxes",
    column: "encrypted_port_token",
    keys: ["canvas_id"],
  },
];

/** A sealed value as stored, with where it is: what opening and sealing it again needs. */
export interface SealedValue {
  /** The primary key's values, in `SealedColumn.keys` order. */
  keys: string[];
  /** The binding's row: the keys joined with `/`. */
  row: string;
  sealed: string;
}

/** How many values in a column were sealed under one key id. */
export interface SealedCount {
  binding: string;
  /** What sits between the first two dots: the key id, or whatever a malformed value has. */
  keyId: string;
  count: number;
}

const KEY_ID = /^[0-9a-f]{8}$/;

function prefixOf(keyId: string): string {
  // The id is hex, so the pattern has nothing in it that LIKE reads as a wildcard.
  if (!KEY_ID.test(keyId)) throw new Error("A vault key id is 8 hex characters.");
  return `pzv1.${keyId}.%`;
}

const ident = (name: string) => sql.identifier(name);
const keyList = (spec: SealedColumn) =>
  sql.join(
    spec.keys.map((key) => ident(key)),
    sql`, `,
  );
const rowOf = (spec: SealedColumn) => sql`concat_ws('/', ${keyList(spec)})`;

/**
 * Up to `limit` values in one column that were not sealed with `currentKeyId`, in primary-key
 * order after `after` (the keys of the last one a previous page answered). Paging by key, not by
 * what is still old, means a value that cannot be sealed again is passed over, not met forever.
 */
export async function listSealedNotUnder(
  db: Db,
  spec: SealedColumn,
  { currentKeyId, after, limit }: { currentKeyId: string; after: string[] | null; limit: number },
): Promise<SealedValue[]> {
  const value = ident(spec.column);
  const conditions: SQL[] = [
    sql`${value} is not null`,
    sql`${value} not like ${prefixOf(currentKeyId)}`,
  ];
  if (after) {
    if (after.length !== spec.keys.length) throw new Error("The cursor does not fit the keys.");
    const cursor = sql.join(
      after.map((part) => sql`${part}::text`),
      sql`, `,
    );
    conditions.push(sql`(${keyList(spec)}) > (${cursor})`);
  }
  const keysJson = sql`json_build_array(${keyList(spec)})`;
  const result = await queryJson<SealedValue[]>(
    db,
    sql`select coalesce(json_agg(json_build_object('keys', page.keys, 'row', page.row, 'sealed', page.sealed) order by page.n), '[]'::json) as result
        from (
          select ${keysJson} as keys, ${rowOf(spec)} as row, ${value} as sealed,
                 row_number() over (order by ${keyList(spec)}) as n
          from ${ident(spec.table)}
          where ${sql.join(conditions, sql` and `)}
          order by ${keyList(spec)}
          limit ${limit}
        ) page`,
  );
  return result ?? [];
}

/**
 * Put `next` in place of `previous`, in one statement, only if the row still holds `previous`.
 * False when it does not (it was deleted, or the API wrote a new value meanwhile, which it seals
 * with the current key), or while the row is busy (`SealedColumn.busyUntil`, by the database's
 * clock): nothing is overwritten. Only the sealed column changes; `updated_at` is left alone,
 * because what the value says did not change.
 */
export async function replaceSealedValue(
  db: Db,
  spec: SealedColumn,
  { keys, previous, next }: { keys: string[]; previous: string; next: string },
): Promise<boolean> {
  if (keys.length !== spec.keys.length) throw new Error("The keys do not fit the column.");
  const value = ident(spec.column);
  const match = spec.keys.map((key, index) => sql`${ident(key)} = ${keys[index]!}`);
  if (spec.busyUntil) {
    const busy = ident(spec.busyUntil);
    match.push(sql`(${busy} is null or ${busy} <= now())`);
  }
  const result = await queryJson<{ replaced: number }>(
    db,
    sql`with replaced as (
          update ${ident(spec.table)} set ${value} = ${next}
          where ${sql.join(match, sql` and `)} and ${value} = ${previous}
          returning 1
        )
        select json_build_object('replaced', count(*)) as result from replaced`,
  );
  return (result?.replaced ?? 0) === 1;
}

/**
 * How many sealed values each column holds under each key id, with no value read out. A
 * column with none is left out. The selfcheck's `vault_old_keys` is the sum of every count
 * whose key id is not the current key's.
 */
export async function countSealedValues(
  db: Db,
  columns: readonly SealedColumn[] = SEALED_COLUMNS,
): Promise<SealedCount[]> {
  if (columns.length === 0) return [];
  const parts = columns.map(
    (spec) =>
      sql`select ${spec.binding}::text as binding, split_part(${ident(spec.column)}, '.', 2) as key_id, count(*)::int as count
          from ${ident(spec.table)} where ${ident(spec.column)} is not null group by 2`,
  );
  const result = await queryJson<SealedCount[]>(
    db,
    sql`select coalesce(json_agg(json_build_object('binding', counts.binding, 'keyId', counts.key_id, 'count', counts.count) order by counts.binding, counts.key_id), '[]'::json) as result
        from (${sql.join(parts, sql` union all `)}) counts`,
  );
  return result ?? [];
}
