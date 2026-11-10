import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDb } from "../testing.ts";
import { QueryError, run } from "./run.ts";

test("a refused statement becomes a QueryError without its parameters", async () => {
  const db = await createTestDb();
  const secret = "sk-live-do-not-log";

  const error = await run(db.execute(sql`select ${secret}::text, 1 / ${0}::int`)).catch(
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(QueryError);
  const refused = error as QueryError;
  expect(refused.message).toBe("division by zero");
  expect(refused.statement).toBe("select $1::text, 1 / $2::int");
  expect((refused.cause as { code?: string }).code).toBe("22012");
  // Drizzle's own error ends with every parameter.
  expect(`${refused.message}\n${refused.stack}`).not.toContain(secret);
  await db.$client.close();
});

test("anything that is not the database refusing a statement passes through as it is", async () => {
  const failure = new Error("the network went away");
  expect(await run(Promise.reject(failure)).catch((thrown: unknown) => thrown)).toBe(failure);
  expect(await run(Promise.resolve(7))).toBe(7);
});

test("no query function awaits or returns a query without going through run", () => {
  const folder = import.meta.dir;
  const bare = readdirSync(folder)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    // `db.$with(…)` names a part of a statement; it runs nothing.
    .filter((name) =>
      /\b(await|return)\s+db\s*\.(?!\$with\()/.test(readFileSync(join(folder, name), "utf8")),
    );

  expect(bare).toEqual([]);
});
