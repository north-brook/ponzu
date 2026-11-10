import { type SQL, sql } from "drizzle-orm";
import { type AnyPgColumn, timestamp } from "drizzle-orm/pg-core";

/** Every time in the schema is a `timestamptz`. */
export const instant = (name: string) => timestamp(name, { withTimezone: true });

export const createdAt = () => instant("created_at").notNull().defaultNow();

/** Set by the database on insert and by every builder update; raw statements set it themselves. */
export const updatedAt = () =>
  instant("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`);

/** The body of a check constraint that holds a text column to a fixed list. */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
}

/**
 * The body of a check constraint that caps a jsonb column's size. Realtime re-sends a watched
 * row whole on every change and a row over 4 MiB ends the subscription for good, so the tables
 * the sandbox writes and clients watch refuse anything large.
 */
export function atMostBytes(column: AnyPgColumn, bytes: number): SQL {
  return sql`octet_length(${column}::text) <= ${sql.raw(String(bytes))}`;
}

/** Anything that survives `JSON.stringify`, for payloads whose shape the API owns. */
export type Json = { [key: string]: unknown };
