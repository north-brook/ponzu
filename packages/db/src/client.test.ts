import { expect, test } from "bun:test";
import { createDb } from "./client.ts";
import { pingDb } from "./queries/ping.ts";
import { QueryError } from "./queries/run.ts";

// A signal that has already aborted fails the request before anything is sent, so this runs
// the real Neon HTTP driver and reaches no network.
const ranOut = () =>
  AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));

test("a statement that runs out of its deadline fails as unavailable, not as refused", async () => {
  const db = createDb("postgres://user:password@database.invalid/ponzu", { deadline: ranOut });

  const error = await pingDb(db).catch((thrown: unknown) => thrown);

  expect(error).toBeInstanceOf(QueryError);
  expect(error).toMatchObject({ unavailable: true, statement: "select 1" });
  // The connection string's password is not in what gets logged.
  expect(JSON.stringify([String(error), (error as Error).stack])).not.toContain("password");
});

test("every statement is given a deadline of its own", async () => {
  let asked = 0;
  const db = createDb("postgres://user:password@database.invalid/ponzu", {
    deadline: () => {
      asked++;
      return ranOut();
    },
  });

  await pingDb(db).catch(() => {});
  await pingDb(db).catch(() => {});

  expect(asked).toBe(2);
});
