/*
 * The scope guard (scope.ts), for every entry point of the package: `vercelSandboxes` (scoped
 * when it is made, so a refused call must never reach fetch) and `scopedSandboxes` over
 * `FakeSandboxes` (as the API's test app holds it, so a refused call must leave the fake's
 * sandboxes as they were). Each call of `Sandboxes` is tried with names of another scope,
 * including names that merely begin with this scope's prefix without its dash.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FakeClock, systemClock } from "./clock.ts";
import { SandboxError } from "./errors.ts";
import { FakeSandboxes } from "./fake.ts";
import {
  CHECK_SCOPE,
  canvasSandboxName,
  isOwnedName,
  ownedPrefix,
  testSandboxName,
} from "./names.ts";
import type { At, Sandboxes, SandboxSpec } from "./sandboxes.ts";
import { scopedSandboxes } from "./scope.ts";
import { vercelSandboxes } from "./vercel.ts";

const MINE = "0123456789ab";
const THEIRS = "ba9876543210";
const SPEC: SandboxSpec = {
  image: `ponzu-runner@sha256:${"a".repeat(64)}`,
  persistent: true,
  timeoutMs: 30 * 60_000,
  ports: [4600],
};

/** Names a module for MINE must refuse. */
const FOREIGN_TO_MINE = [
  // Another database's canvas and sign-in.
  canvasSandboxName(THEIRS, "cnv_theirs"),
  `pz-${THEIRS}-signin-as_1`,
  // Begins with "pz-<MINE>" but is another scope: no dash after it (pz-dev- against pz-development-).
  `pz-${MINE}ff-cnv_x`,
  `pz-${MINE}cnv_x`,
  // The prefix alone, with nothing after it, and the live suites' names.
  `pz-${MINE}-`,
  "pz-test-live-abcd1234",
  // Not a sandbox name at all.
  "other",
  "",
  `pz-${MINE}-../x`,
];

/** Names a module for CHECK_SCOPE must refuse. */
const FOREIGN_TO_CHECKS = [
  canvasSandboxName(MINE, "cnv_mine"),
  "pz-tester-x",
  "pz-testing-live-x",
  "pz-test-",
  "pz-tes-x",
];

type Call = (sandboxes: Sandboxes, name: string) => Promise<unknown>;
const at = (name: string): At => ({ name, sessionId: "sbx_session" });

/** Every call of `Sandboxes`, each naming `name` (list with `name` as its prefix). */
const CALLS: Record<keyof Sandboxes, Call> = {
  up: (s, name) => s.up(name, SPEC),
  status: (s, name) => s.status(name),
  list: (s, name) => s.list(name),
  start: (s, name) => s.start(at(name), { cmd: "true" }),
  exec: (s, name) => s.exec(at(name), { cmd: "true", timeoutMs: 1_000 }),
  writeFile: (s, name) => s.writeFile(at(name), "/tmp/x", "x"),
  readFile: (s, name) => s.readFile(at(name), "/tmp/x"),
  extend: (s, name) => s.extend(at(name), 60_000),
  stop: (s, name) => s.stop(at(name)),
  remove: (s, name) => s.remove(name),
};

/** The scope's own prefix is a name no call may take, but the listing every call of list makes. */
const refusable = (op: keyof Sandboxes, scope: string, names: readonly string[]) =>
  op === "list" ? names.filter((name) => name !== ownedPrefix(scope)) : names;

async function codeOf(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => "done",
    (error: unknown) => (error instanceof SandboxError ? error.code : `threw ${String(error)}`),
  );
}

/** A fetch that records every request and answers none: a refused call must never reach it. */
function noNetwork() {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("the guard let a request through");
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const credentials = { token: "test-token", teamId: "team_test", projectId: "prj_test" };

describe("vercelSandboxes refuses another scope's names before any request", () => {
  for (const [op, call] of Object.entries(CALLS) as [keyof Sandboxes, Call][]) {
    test(op, async () => {
      for (const [scope, foreign] of [
        [MINE, FOREIGN_TO_MINE],
        [CHECK_SCOPE, FOREIGN_TO_CHECKS],
      ] as const) {
        const net = noNetwork();
        const sandboxes = vercelSandboxes({
          clock: systemClock,
          scope,
          credentials,
          fetch: net.fetch,
        });
        for (const name of refusable(op, scope, foreign)) {
          expect({ name, code: await codeOf(call(sandboxes, name)) }).toEqual({
            name,
            code: "out_of_scope",
          });
        }
        expect(net.calls).toEqual([]);
      }
    });
  }

  test("its own names go through to Vercel", async () => {
    const net = noNetwork();
    const sandboxes = vercelSandboxes({
      clock: systemClock,
      scope: MINE,
      credentials,
      fetch: net.fetch,
    });
    // The fetch throws, so the call fails as unavailable: what matters is that it was sent.
    expect(await codeOf(sandboxes.status(canvasSandboxName(MINE, "cnv_mine")))).toBe("unavailable");
    expect(net.calls.length).toBeGreaterThan(0);
  }, 30_000);

  test("a listing Vercel answers with another scope's name is refused, not filtered", async () => {
    const recorded = (await Bun.file(
      join(import.meta.dir, "fixtures", "vercel-live.json"),
    ).json()) as {
      exchanges: {
        step: string;
        method: string;
        status: number;
        headers: Record<string, string>;
        body: string;
      }[];
    };
    const listed = recorded.exchanges.find(
      (each) => each.step === "list" && each.method === "GET",
    )!;
    const body = JSON.parse(listed.body);
    // As if Vercel's namePrefix filter let one through: one of production's, say.
    body.sandboxes[0].name = canvasSandboxName(THEIRS, "cnv_theirs");
    const fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: listed.status,
        headers: listed.headers,
      })) as unknown as typeof globalThis.fetch;
    const sandboxes = vercelSandboxes({
      clock: systemClock,
      scope: CHECK_SCOPE,
      credentials,
      fetch,
    });
    const error = await sandboxes.list("pz-test-live-").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).code).toBe("out_of_scope");
  });

  test("there is no module without a scope: a bad one throws when it is made", () => {
    for (const scope of ["", "dev", "production", "pz", "0123456789AB", "0123456789abc", "tests"]) {
      expect(() => vercelSandboxes({ clock: systemClock, scope, credentials })).toThrow();
    }
  });
});

describe("scopedSandboxes over the fake refuses another scope's names and leaves them be", () => {
  for (const [op, call] of Object.entries(CALLS) as [keyof Sandboxes, Call][]) {
    test(op, async () => {
      const fake = new FakeSandboxes(new FakeClock());
      // Another scope's sandboxes, running, in the same project.
      const running = [canvasSandboxName(THEIRS, "cnv_theirs"), `pz-${MINE}ff-cnv_x`];
      const sessions = new Map<string, string>();
      for (const name of running) sessions.set(name, (await fake.up(name, SPEC)).sessionId);
      const mine = scopedSandboxes(fake, MINE);
      for (const name of refusable(op, MINE, FOREIGN_TO_MINE)) {
        expect({ name, code: await codeOf(call(mine, name)) }).toEqual({
          name,
          code: "out_of_scope",
        });
      }
      // The same calls pinned to the real sessions of the running ones.
      for (const name of running) {
        const pinned: At = { name, sessionId: sessions.get(name)! };
        const real: Sandboxes = new Proxy(mine, {
          get: (target, key) => {
            const method = Reflect.get(target, key) as (...args: unknown[]) => unknown;
            return (...args: unknown[]) =>
              method.apply(
                target,
                args.map((arg) =>
                  arg && typeof arg === "object" && "sessionId" in arg ? pinned : arg,
                ),
              );
          },
        });
        expect(await codeOf(call(real, name))).toBe("out_of_scope");
      }
      for (const name of running) {
        expect((await fake.status(name))?.status).toBe("running");
        expect((await fake.status(name))?.sessionId).toBe(sessions.get(name)!);
        expect(fake.commands(name)).toEqual([]);
        expect(fake.files(name).size).toBe(0);
      }
      // up() made nothing under a foreign name.
      expect((await fake.list("pz-")).map((each) => each.name).sort()).toEqual([...running].sort());
    });
  }

  test("its own names and narrower listings go through", async () => {
    const fake = new FakeSandboxes(new FakeClock());
    const mine = scopedSandboxes(fake, MINE);
    const name = canvasSandboxName(MINE, "cnv_mine");
    const up = await mine.up(name, SPEC);
    await fake.up(canvasSandboxName(THEIRS, "cnv_theirs"), SPEC);
    expect((await mine.list(`pz-${MINE}-`)).map((each) => each.name)).toEqual([name]);
    expect(await mine.list(`pz-${MINE}-signin-`)).toEqual([]);
    expect(
      await mine.exec({ name, sessionId: up.sessionId }, { cmd: "true", timeoutMs: 1_000 }),
    ).toMatchObject({
      exitCode: 0,
    });
    expect(await mine.stop({ name, sessionId: up.sessionId })).toMatchObject({ stopped: true });
    await mine.remove(name);
    expect(await fake.status(name)).toBeNull();
  });

  test("a check module touches only pz-test- names", async () => {
    const fake = new FakeSandboxes(new FakeClock());
    const checks = scopedSandboxes(fake, CHECK_SCOPE);
    const name = testSandboxName("live");
    await checks.up(name, SPEC);
    for (const foreign of FOREIGN_TO_CHECKS) {
      expect(await codeOf(checks.remove(foreign))).toBe("out_of_scope");
    }
    expect(await codeOf(checks.list("pz-"))).toBe("out_of_scope");
    expect((await checks.list("pz-test-")).map((each) => each.name)).toEqual([name]);
    await checks.remove(name);
  });

  test("an inner listing that answers another scope's name is refused, not filtered", async () => {
    const fake = new FakeSandboxes(new FakeClock());
    await fake.up(canvasSandboxName(THEIRS, "cnv_theirs"), SPEC);
    // An inner module whose listing ignores the prefix, as a later change might.
    const leaky: Sandboxes = Object.assign(Object.create(fake) as FakeSandboxes, {
      list: () => fake.list("pz-"),
    });
    expect(await codeOf(scopedSandboxes(leaky, MINE).list(`pz-${MINE}-`))).toBe("out_of_scope");
  });
});

describe("prefixes", () => {
  test("a scope's prefix ends in a dash, so one scope's never begins another's", () => {
    expect(ownedPrefix(MINE)).toBe(`pz-${MINE}-`);
    expect(ownedPrefix(CHECK_SCOPE)).toBe("pz-test-");
    expect(isOwnedName("pz-dev-", "pz-development-x")).toBe(false);
    expect(isOwnedName("pz-dev-", "pz-dev-x")).toBe(true);
    expect(isOwnedName(ownedPrefix(MINE), `pz-${MINE}ff-x`)).toBe(false);
    expect(isOwnedName(ownedPrefix(CHECK_SCOPE), "pz-tester-x")).toBe(false);
    expect(isOwnedName(ownedPrefix(MINE), `pz-${MINE}-${"x".repeat(200)}`)).toBe(false);
  });

  test("a scope that is neither 12 hex nor the check scope has no prefix", () => {
    for (const scope of ["", "dev", "preview", "0123456789ab-", "0123456789AB"]) {
      expect(() => ownedPrefix(scope)).toThrow();
    }
  });
});
