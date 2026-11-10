import type { SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import { run } from "./run.ts";

/**
 * Run a statement that answers with one json document in a column named `result`.
 *
 * Drivers disagree about what a raw statement hands back (a bigint is a string from one and a
 * number from another; a timestamp arrives unparsed), and json is the one thing they all return
 * the same way. So a statement the query builder cannot express builds its answer in Postgres.
 */
export async function queryJson<T extends object>(db: Db, statement: SQL): Promise<T | null> {
  const { rows } = (await run(db.execute(statement))) as unknown as {
    rows: { result: unknown }[];
  };
  const result = rows[0]?.result ?? null;
  return (typeof result === "string" ? JSON.parse(result) : result) as T | null;
}

/** A time as a statement parameter, the same for every driver. Cast it with `::timestamptz`. */
export function timeParam(time: Date): string {
  return time.toISOString();
}
