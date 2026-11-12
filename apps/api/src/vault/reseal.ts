/*
 * Sealing again, under the current vault key, every stored value an old key sealed: what lets
 * an old key leave PONZU_VAULT_OLD_KEYS after a rotation (docs/production.md, "Secrets
 * rotation"). apps/api/scripts/reseal.ts runs it against a deployment's database.
 *
 * Each value is opened with its own binding and sealed again to the same one, and written back
 * in its own statement, only if the row still holds what was read. So it can stop anywhere and
 * run again, a value the API rewrote meanwhile is never overwritten, and a second run over a
 * finished database changes nothing.
 *
 * The report has counts per column and key id, and the rows that could not be sealed again
 * (their keys, which are ids and secret names, never values).
 */
import {
  countSealedValues,
  type Db,
  listSealedNotUnder,
  replaceSealedValue,
  SEALED_COLUMNS,
  type SealedColumn,
} from "@ponzu/db";
import { sealedKeyId, type Vault } from "./vault.ts";

const PAGE = 100;

/** Why a value was left as it is. */
export type ResealFailure =
  /** Not `pzv1.<key id>.<nonce>.<ciphertext>`. */
  | "malformed"
  /** Sealed with a key that is neither PONZU_VAULT_KEY nor in PONZU_VAULT_OLD_KEYS. */
  | "key_not_held"
  /** The key is held but the value does not open as its column and row: altered or moved. */
  | "does_not_open";

/** What happened to the values one key sealed into one column. */
export interface ResealCount {
  binding: string;
  /** The key that had sealed them; "?" for values not in the vault's format. */
  keyId: string;
  /** Sealed again under the current key (with `dryRun`, the ones that would be). */
  resealed: number;
  /** Rewritten by the API between the read and the write, so left as the API wrote it. */
  changed: number;
  failed: number;
}

export interface ResealReport {
  currentKeyId: string;
  dryRun: boolean;
  counts: ResealCount[];
  /** Every value left behind, by where it is. */
  failures: { binding: string; row: string; keyId: string; reason: ResealFailure }[];
}

export async function resealAll(
  { db, vault }: { db: Db; vault: Vault },
  {
    dryRun = false,
    columns = SEALED_COLUMNS,
  }: { dryRun?: boolean; columns?: readonly SealedColumn[] } = {},
): Promise<ResealReport> {
  const { current, old } = await vault.keyIds();
  const report: ResealReport = { currentKeyId: current, dryRun, counts: [], failures: [] };

  for (const spec of columns) {
    const counts = new Map<string, ResealCount>();
    const countFor = (keyId: string) => {
      let count = counts.get(keyId);
      if (!count) {
        count = { binding: spec.binding, keyId, resealed: 0, changed: 0, failed: 0 };
        counts.set(keyId, count);
      }
      return count;
    };

    let after: string[] | null = null;
    for (;;) {
      const page = await listSealedNotUnder(db, spec, {
        currentKeyId: current,
        after,
        limit: PAGE,
      });
      for (const { keys, row, sealed } of page) {
        const keyId = sealedKeyId(sealed);
        const count = countFor(keyId ?? "?");
        const fail = (reason: ResealFailure) => {
          count.failed++;
          report.failures.push({ binding: spec.binding, row, keyId: keyId ?? "?", reason });
        };
        if (!keyId) {
          fail("malformed");
          continue;
        }
        if (!old.includes(keyId)) {
          fail("key_not_held");
          continue;
        }
        const binding = { column: spec.binding, row };
        let plaintext: string;
        try {
          plaintext = await vault.open(sealed, binding);
        } catch {
          fail("does_not_open");
          continue;
        }
        if (dryRun) {
          count.resealed++;
          continue;
        }
        const next = await vault.seal(plaintext, binding);
        if (await replaceSealedValue(db, spec, { keys, previous: sealed, next })) count.resealed++;
        else count.changed++;
      }
      if (page.length < PAGE) break;
      after = page.at(-1)!.keys;
    }
    report.counts.push(...[...counts.values()].sort((a, b) => a.keyId.localeCompare(b.keyId)));
  }
  return report;
}

/**
 * How many stored values the current key did not seal: what the selfcheck reports as
 * `vault_old_keys`, ok at 0. Reads key ids only, never a value.
 */
export async function countSealedUnderOldKeys({ db, vault }: { db: Db; vault: Vault }) {
  const { current } = await vault.keyIds();
  const counts = await countSealedValues(db);
  return counts.filter(({ keyId }) => keyId !== current).reduce((sum, { count }) => sum + count, 0);
}
