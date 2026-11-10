import { afterEach, expect, test } from "bun:test";
import { createLogger, type LogLine } from "../http/log.ts";
import { createBackground, waitUntil } from "./background.ts";

const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const globals = globalThis as Record<symbol, unknown>;
afterEach(() => {
  delete globals[REQUEST_CONTEXT];
});

test("on Vercel, work is handed to the request's waitUntil", () => {
  const kept: Promise<void>[] = [];
  globals[REQUEST_CONTEXT] = {
    get: () => ({ waitUntil: (work: Promise<void>) => kept.push(work) }),
  };
  const work = Promise.resolve();

  waitUntil(work);

  expect(kept).toEqual([work]);
});

test("anywhere else there is nothing to hand it to, and that is fine", () => {
  expect(() => waitUntil(Promise.resolve())).not.toThrow();
  globals[REQUEST_CONTEXT] = { get: () => undefined };
  expect(() => waitUntil(Promise.resolve())).not.toThrow();
});

test("what is kept never rejects: a failure becomes a log line with the work's name", async () => {
  const lines: LogLine[] = [];
  const kept: Promise<void>[] = [];
  const background = createBackground(
    createLogger((line) => lines.push(line)),
    (work) => kept.push(work),
  );

  background("wake", Promise.reject(new Error("boat.dev is down")));
  background("sync", Promise.resolve("done"));

  expect(await Promise.all(kept)).toEqual([undefined, undefined]);
  expect(lines).toMatchObject([
    {
      level: "error",
      event: "background_failed",
      name: "wake",
      error: { message: "boat.dev is down" },
    },
  ]);
});
