import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getClaudeAccount } from "@ponzu/db";
import { SandboxError, signInSandboxName } from "@ponzu/sandbox";
import { lifetime } from "../claude/sign-in.ts";
import { call } from "../testing/designs.ts";
import { createTestApp, TEST_CRON_SECRET, TEST_SCOPE, type TestApp } from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const KEY = "sk-ant-api03-a-real-looking-key-4f2a";
const TOKEN = `sk-ant-oat01-${"T".repeat(80)}`;
const CODE = "k7Hq2Rw9xTpL4mZ#state-from-claude";
const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=c&state=s";
const HOME = "/vercel/.st";

/** A fresh sign-in, as the test clock can run past an access token's five minutes. */
const as = async (login: string) => (await t.signInAs({ login })).headers;
const nameOf = (id: string) => signInSandboxName(TEST_SCOPE, id);

/**
 * The driver in the utility sandbox, acted out over the fake sandboxes: `start` leaves the
 * address in its out file, and `code` takes the code the API wrote into the sandbox and, if it
 * is the one claude.ai would take, leaves the token in its file. Neither ever prints anything.
 */
const codes: string[] = [];
beforeAll(() => {
  const sandboxes = t.sandboxes;
  const write = sandboxes.writeFile.bind(sandboxes);
  sandboxes.writeFile = async (at, path, content, options) => {
    if (path === `${HOME}/code`) codes.push(String(content));
    return write(at, path, content, options);
  };
  const exec = sandboxes.exec.bind(sandboxes);
  sandboxes.exec = async (at, command, options) => {
    const result = await exec(at, command, options);
    if (command.cmd !== "bash") return result;
    if (command.args?.[1] === "start") {
      await write(at, `${HOME}/start.out`, `URL=${URL}\n`);
    } else if (command.args?.[1] === "code") {
      if (codes.at(-1) !== CODE) {
        await write(at, `${HOME}/code.out`, "NO_TOKEN\nOAuth error: That code wasn't accepted.\n");
        return { ...result, exitCode: 1 };
      }
      await write(at, `${HOME}/token`, TOKEN);
      await write(at, `${HOME}/code.out`, "TOKEN_SAVED valid for 1 year\n");
    }
    return result;
  };
});

describe("an API key", () => {
  test("Anthropic is asked first; one it does not take is refused and nothing is stored", async () => {
    const headers = await as("ada");
    const refused = await call(t, headers, "POST", "/v1/claude/api-key", {
      key: "sk-ant-nope-0000000000000",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("claude_key_invalid");
    expect((await call(t, headers, "GET", "/v1/claude")).body).toEqual({ account: null });
  });

  test("one it takes is sealed to its row and shown by its last four characters", async () => {
    t.anthropic.keys.add(KEY);
    const headers = await as("ada");
    const connected = await call(t, headers, "POST", "/v1/claude/api-key", { key: ` ${KEY} ` });
    expect(connected.status).toBe(200);
    expect(connected.body.account).toMatchObject({
      kind: "api_key",
      status: "connected",
      label: "Anthropic API key · sk-ant-…4f2a",
      expiresAt: null,
      expiresSoon: false,
    });

    const rows = (await t.db.execute(
      "select id, encrypted_credential from claude_accounts where key_hint = '4f2a'",
    )) as unknown as { rows: { id: string; encrypted_credential: string }[] };
    const [stored] = rows.rows;
    expect(stored!.encrypted_credential).not.toContain(KEY);
    expect(
      await t.deps.vault.open(stored!.encrypted_credential, {
        column: "claude_accounts.encrypted_credential",
        row: stored!.id,
      }),
    ).toBe(KEY);
    expect(JSON.stringify(t.logs)).not.toContain(KEY);
    // /v1/me says so too.
    expect((await call(t, headers, "GET", "/v1/me")).body.claudeAccount.kind).toBe("api_key");
  });

  test("Anthropic not answering is the upstream's failure, not the key's", async () => {
    t.anthropic.failing = true;
    try {
      const failed = await call(t, await as("ada"), "POST", "/v1/claude/api-key", { key: KEY });
      expect(failed.status).toBe(502);
      expect(failed.body.error.code).toBe("upstream_unavailable");
    } finally {
      t.anthropic.failing = false;
    }
  });
});

describe("a subscription sign-in", () => {
  const start = async (headers: Record<string, string>) => {
    const started = await call(t, headers, "POST", "/v1/claude/sign-ins");
    expect(started.status).toBe(201);
    return started.body as { id: string; authorizeUrl: string; expiresAt: string };
  };
  const exists = async (id: string) => (await t.sandboxes.status(nameOf(id))) !== null;

  test("runs Claude Code's own sign-in in a sandbox with no credential, and takes the code back as a file", async () => {
    const headers = await as("bea");
    const asked = t.clock.now();
    const started = await start(headers);
    expect(started).toEqual({
      id: expect.stringMatching(/^auth_/),
      authorizeUrl: URL,
      // Ten minutes from the ask; the sandbox taking a few seconds to start does not shorten it.
      expiresAt: new Date(asked + 10 * 60_000).toISOString(),
    });
    const name = nameOf(started.id);
    // Made for this alone: not kept, no port, and no command carries any environment.
    expect(t.sandboxes.config(name).spec).toMatchObject({ persistent: false, ports: [] });
    expect(t.sandboxes.commands(name)).toEqual([
      {
        sessionId: expect.any(String),
        kind: "exec",
        command: { cmd: "bash", args: [`${HOME}/driver.sh`, "start"] },
      },
    ]);

    const finished = await call(t, headers, "POST", `/v1/claude/sign-ins/${started.id}/code`, {
      code: CODE,
    });
    await t.backgroundDone();
    expect(finished.status).toBe(200);
    expect(finished.body.account).toMatchObject({
      kind: "subscription",
      status: "connected",
      label: "Claude subscription",
      expiresSoon: false,
    });
    expect(new Date(finished.body.account.expiresAt).getTime()).toBe(
      t.clock.now() + 365 * 24 * 3600_000,
    );
    // The utility sandbox is gone, and neither the code nor the token went into a command or a log.
    expect(await exists(started.id)).toBe(false);
    const commands = JSON.stringify(t.sandboxes.commands(name));
    for (const secret of [CODE, TOKEN]) {
      expect(commands).not.toContain(secret);
      expect(JSON.stringify(t.logs)).not.toContain(secret);
    }
  });

  test("a code without its second half is refused before it is tried, and the sign-in stays open", async () => {
    const headers = await as("cy");
    const { id } = await start(headers);
    const half = await call(t, headers, "POST", `/v1/claude/sign-ins/${id}/code`, {
      code: "k7Hq2Rw9xTpL4mZ",
    });
    expect(half.status).toBe(400);
    expect(half.body.error.code).toBe("claude_code_invalid");
    const whole = await call(t, headers, "POST", `/v1/claude/sign-ins/${id}/code`, { code: CODE });
    expect(whole.status).toBe(200);
  });

  test("a wrong code, a used sign-in and an expired one each say so", async () => {
    const headers = await as("dee");
    const first = await start(headers);
    const wrong = await call(t, headers, "POST", `/v1/claude/sign-ins/${first.id}/code`, {
      code: "wrong#code",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("claude_code_invalid");
    // A code is good for one try: the sign-in is used up.
    const again = await call(t, headers, "POST", `/v1/claude/sign-ins/${first.id}/code`, {
      code: CODE,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("claude_sign_in_used");

    const second = await start(headers);
    t.clock.advance(11 * 60_000);
    const late = await call(t, await as("dee"), "POST", `/v1/claude/sign-ins/${second.id}/code`, {
      code: CODE,
    });
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe("claude_sign_in_expired");

    const someoneElse = await call(
      t,
      await as("eli"),
      "POST",
      `/v1/claude/sign-ins/${second.id}/code`,
      {
        code: CODE,
      },
    );
    expect(someoneElse.status).toBe(404);
    expect(await getClaudeAccount(t.db, (await t.signInAs({ login: "dee" })).userId)).toBeNull();
  });

  test("abandoned sign-ins lose their sandboxes to the sweep's reconcile", async () => {
    const headers = await as("fay");
    const { id } = await start(headers);
    const cron = async () =>
      t.app.request("/v1/cron/minute", {
        headers: { authorization: `Bearer ${TEST_CRON_SECRET}` },
      });
    /** On to the next tenth minute, when reconcile runs. */
    const toReconcile = () => {
      const minute = new Date(t.clock.now()).getUTCMinutes();
      t.clock.advance(((10 - (minute % 10)) % 10) * 60_000 + 1000);
    };
    t.clock.advance(11 * 60_000);
    toReconcile();
    await cron();
    // Under an hour old and never finished: it may still be coming back.
    expect(await exists(id)).toBe(true);
    t.clock.advance(50 * 60_000);
    toReconcile();
    expect((await cron()).status).toBe(200);
    expect(await exists(id)).toBe(false);
  });

  test("giving one up removes its sandbox at once", async () => {
    const headers = await as("gus");
    const { id } = await start(headers);
    expect(await exists(id)).toBe(true);
    expect((await call(t, headers, "DELETE", `/v1/claude/sign-ins/${id}`)).status).toBe(204);
    await t.backgroundDone();
    expect(await exists(id)).toBe(false);
    const used = await call(t, headers, "POST", `/v1/claude/sign-ins/${id}/code`, { code: CODE });
    expect(used.body.error.code).toBe("claude_sign_in_used");
  });

  test("a person has one open at a time: a new one replaces the last, and its sandbox goes", async () => {
    const headers = await as("ivy");
    const first = await start(headers);
    await start(headers);
    await t.backgroundDone();
    expect(await exists(first.id)).toBe(false);
    const replaced = await call(t, headers, "POST", `/v1/claude/sign-ins/${first.id}/code`, {
      code: CODE,
    });
    expect(replaced.body.error.code).toBe("claude_sign_in_used");
  });

  test("five an hour: the next is refused before any sandbox is made", async () => {
    const headers = await as("jo");
    for (let i = 0; i < 5; i++) await start(headers);
    await t.backgroundDone();
    const live = async () =>
      (await t.sandboxes.list(`pz-${TEST_SCOPE}-signin-`)).filter(
        (sandbox) => sandbox.status === "running",
      ).length;
    const before = await live();
    const sixth = await call(t, headers, "POST", "/v1/claude/sign-ins");
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe("rate_limited");
    expect(await live()).toBe(before);

    t.clock.advance(61 * 60_000);
    await start(await as("jo"));
  });

  test("a sandbox that cannot be started is Claude being out of reach", async () => {
    const up = t.sandboxes.up.bind(t.sandboxes);
    t.sandboxes.up = async () => {
      t.sandboxes.up = up;
      throw new SandboxError("rate_limited", "429", { retryAfterSeconds: 9 });
    };
    const failed = await call(t, await as("hal"), "POST", "/v1/claude/sign-ins");
    expect(failed.status).toBe(502);
    expect(failed.body.error.message).toContain("Claude");
  });

  test("how long the token is good for is read from what setup-token says", () => {
    const day = 24 * 3600_000;
    expect(lifetime("1 year")).toBe(365 * day);
    expect(lifetime("90 days")).toBe(90 * day);
    expect(lifetime(undefined)).toBe(365 * day);
  });
});

describe("defaults", () => {
  test("new designs start on Opus 5.5 at medium, and a person's choice is kept", async () => {
    const headers = await as("ivy");
    const before = await call(t, headers, "GET", "/v1/claude/defaults");
    expect(before.body).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
    expect(before.body.models.map((m: { label: string }) => m.label)).toEqual([
      "Fable 5.2",
      "Opus 5.5",
      "Sonnet 5.5",
      "Haiku 5.5",
    ]);
    const changed = await call(t, headers, "PATCH", "/v1/claude/defaults", {
      model: "claude-haiku-5-5",
    });
    expect(changed.body).toMatchObject({ model: "claude-haiku-5-5", effort: "medium" });
    const bad = await call(t, headers, "PATCH", "/v1/claude/defaults", { model: "gpt-9" });
    expect(bad.status).toBe(400);
  });
});
