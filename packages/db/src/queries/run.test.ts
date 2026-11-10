// What `run` does with a statement Postgres refuses is tested where one is refused: in
// thread.test.ts for the query builder and ops.test.ts for a raw statement.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./run.ts";

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
