import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { getLiveSandbox, upsertRepos } from "@ponzu/db";
import { decodeRepoSecrets, REPO_SECRETS_VARIABLE } from "@ponzu/runner/protocol";
import { secretBinding } from "../environments/secrets.ts";
import { call, designIn, type Workspace, workspaceWithRepo } from "../testing/designs.ts";
import { createTestApp, TEST_VAULT_KEY, type TestApp } from "../testing/index.ts";
import { createVault } from "../vault/vault.ts";

/*
 * Settings › Environments through the routes, and a repo's secrets reaching its sandboxes: who
 * may see and change what, the names a secret may not have, and a value that never comes back.
 */

let t: TestApp;
let ws: Workspace;
/** A second repo of the workspace that only Ada can read. */
let hidden: { id: string };
const DATABASE_URL = "postgres://app:hunter2-not-a-real-one@db.internal:5432/app";
/** The test app's own vault key: what it seals with. */
const vault = createVault({ key: TEST_VAULT_KEY });

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { ada: "admin", ben: "write", cy: "read" });
  const githubRepoId = 990_001;
  const [lenny] = await upsertRepos(t.db, {
    workspaceId: ws.id,
    repos: [
      {
        githubRepoId,
        fullName: `${ws.github.installation.account.login}/lenny`,
        defaultBranch: "main",
        private: true,
        pushedAt: null,
      },
    ],
  });
  hidden = { id: lenny!.id };
  ws.github.installation.repositories.push({
    id: githubRepoId,
    fullName: `${ws.github.installation.account.login}/lenny`,
    private: true,
    access: { [ws.people.ada!.github.id]: "write" },
  });
});
afterAll(() => t.close());

const as = async (login: string) => (await t.signInAs({ login })).headers;
const env = (repoId = ws.repo.id) => `/v1/repos/${repoId}/environment`;

describe("the list", () => {
  test("is empty until a repo has something to show", async () => {
    const got = await call(t, await as("ada"), "GET", `/v1/workspaces/${ws.id}/environments`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ repos: [], canManageSecrets: true });
  });

  test("lists a repo once it has a secret, by name, for whoever can read it", async () => {
    const ada = await as("ada");
    const added = await call(t, ada, "POST", `${env()}/secrets`, {
      name: "DATABASE_URL",
      value: DATABASE_URL,
    });
    expect(added.status).toBe(201);
    expect(added.body.environment.secrets).toEqual([
      { name: "DATABASE_URL", updatedAt: expect.any(String) },
    ]);
    expect(added.body).toMatchObject({ canManageSecrets: true, canRebuild: true });

    const listed = await call(t, await as("cy"), "GET", `/v1/workspaces/${ws.id}/environments`);
    expect(listed.body.canManageSecrets).toBe(false);
    expect(listed.body.repos).toHaveLength(1);
    expect(listed.body.repos[0]).toMatchObject({
      repo: { id: ws.repo.id, name: "fernwood", fullName: ws.repo.fullName },
      base: { status: "none", builtAt: null, stack: [], rebuild: { requestedAt: null } },
      secrets: [{ name: "DATABASE_URL" }],
    });
  });

  test("leaves out a repo the person cannot read", async () => {
    await call(t, await as("ada"), "POST", `${env(hidden.id)}/secrets`, {
      name: "OPENAI_KEY",
      value: "sk-hidden",
    });
    const ada = await call(t, await as("ada"), "GET", `/v1/workspaces/${ws.id}/environments`);
    expect(ada.body.repos).toHaveLength(2);
    const cy = await call(t, await as("cy"), "GET", `/v1/workspaces/${ws.id}/environments`);
    expect(cy.body.repos.map((r: { repo: { id: string } }) => r.repo.id)).toEqual([ws.repo.id]);
    const asked = await call(t, await as("cy"), "GET", env(hidden.id));
    expect(asked.status).toBe(404);
  });

  test("is nobody's outside the workspace", async () => {
    await workspaceWithRepo(t, { zed: "admin" });
    const zed = await as("zed");
    expect((await call(t, zed, "GET", `/v1/workspaces/${ws.id}/environments`)).status).toBe(404);
    expect((await call(t, zed, "GET", env())).status).toBe(404);
    const write = await call(t, zed, "POST", `${env()}/secrets`, { name: "X", value: "y" });
    expect(write.status).toBe(404);
  });
});

describe("secrets", () => {
  test("only a workspace admin adds, replaces or removes one", async () => {
    for (const who of ["ben", "cy"]) {
      const headers = await as(who);
      const add = await call(t, headers, "POST", `${env()}/secrets`, { name: "A", value: "b" });
      expect(add.status).toBe(403);
      const put = await call(t, headers, "PUT", `${env()}/secrets/DATABASE_URL`, { value: "x" });
      expect(put.status).toBe(403);
      const del = await call(t, headers, "DELETE", `${env()}/secrets/DATABASE_URL`);
      expect(del.status).toBe(403);
    }
  });

  test("refuse a name that would replace or steer what Ponzu puts in a sandbox", async () => {
    const ada = await as("ada");
    for (const name of [
      "PONZU_RUNNER_TOKEN",
      "PONZU_API_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "PATH",
      "HOME",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "HTTPS_PROXY",
      "GIT_ASKPASS",
      // What loads code into a program as it starts, or changes how it checks TLS.
      "BUN_OPTIONS",
      "BUN_CONFIG_REGISTRY",
      "NODE_PATH",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "NPM_CONFIG_REGISTRY",
      "BASH_ENV",
      "BASH_FUNC_LS",
      "ENV",
      "SHELLOPTS",
      "PS4",
      "PROMPT_COMMAND",
      "PYTHONSTARTUP",
      "XDG_CONFIG_HOME",
      "DYLD_INSERT_LIBRARIES",
      "CURL_CA_BUNDLE",
    ]) {
      const refused = await call(t, ada, "POST", `${env()}/secrets`, { name, value: "x" });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe("secret_name_reserved");
    }
  });

  test("allow how a repo's own code runs and installs, under Node's prefix", async () => {
    const ada = await as("ada");
    for (const name of ["NODE_ENV", "NODE_AUTH_TOKEN"]) {
      const added = await call(t, ada, "POST", `${env(hidden.id)}/secrets`, { name, value: "x" });
      expect(added.status).toBe(201);
      await call(t, ada, "DELETE", `${env(hidden.id)}/secrets/${name}`);
    }
  });

  test("refuse a name that is not an environment variable's", async () => {
    const ada = await as("ada");
    for (const name of [
      "lowercase",
      "1STARTS_WITH_A_DIGIT",
      "_LEADING",
      "HAS-DASH",
      "A B",
      "",
      "A".repeat(65),
    ]) {
      const refused = await call(t, ada, "POST", `${env()}/secrets`, { name, value: "x" });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe("invalid_request");
    }
  });

  test("refuse a value that is empty, too large or holds a NUL", async () => {
    const ada = await as("ada");
    for (const value of ["", "x".repeat(16 * 1024 + 1), "a\u0000b"]) {
      const refused = await call(t, ada, "POST", `${env()}/secrets`, { name: "BIG", value });
      expect(refused.status).toBe(400);
    }
    const fits = await call(t, ada, "POST", `${env()}/secrets`, {
      name: "PRIVATE_KEY",
      value: "k".repeat(16 * 1024),
    });
    expect(fits.status).toBe(201);
    await call(t, ada, "DELETE", `${env()}/secrets/PRIVATE_KEY`);
  });

  test("an existing name is replaced, never added twice", async () => {
    const ada = await as("ada");
    const twice = await call(t, ada, "POST", `${env()}/secrets`, {
      name: "DATABASE_URL",
      value: "other",
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("secret_exists");
    const missing = await call(t, ada, "PUT", `${env()}/secrets/NOPE`, { value: "x" });
    expect(missing.status).toBe(404);
  });

  test("are sealed to their row, and their value never comes back or reaches a log", async () => {
    const ada = await as("ada");
    const replaced = await call(t, ada, "PUT", `${env()}/secrets/DATABASE_URL`, {
      value: DATABASE_URL,
    });
    expect(replaced.status).toBe(200);
    const read = await call(t, await as("cy"), "GET", env());
    expect(JSON.stringify([replaced.body, read.body])).not.toContain("hunter2");
    expect(JSON.stringify(t.logs)).not.toContain("hunter2");

    const { rows } = (await t.db.execute(
      `select encrypted_value from repo_secrets where repo_id = '${ws.repo.id}' and name = 'DATABASE_URL'`,
    )) as unknown as { rows: { encrypted_value: string }[] };
    const sealed = rows[0]!.encrypted_value;
    expect(sealed).not.toContain("hunter2");
    expect(await vault.open(sealed, secretBinding(ws.repo.id, "DATABASE_URL"))).toBe(DATABASE_URL);
    // Bound to the row: under another name or repo it does not open.
    await expect(vault.open(sealed, secretBinding(ws.repo.id, "OTHER"))).rejects.toThrow();
    await expect(vault.open(sealed, secretBinding(hidden.id, "DATABASE_URL"))).rejects.toThrow();
  });

  test("a repo holds at most fifty", async () => {
    const ada = await as("ada");
    const repo = env(hidden.id);
    // OPENAI_KEY is one already.
    for (let i = 1; i < 50; i++) {
      const added = await call(t, ada, "POST", `${repo}/secrets`, { name: `K${i}`, value: "v" });
      expect(added.status).toBe(201);
    }
    const full = await call(t, ada, "POST", `${repo}/secrets`, { name: "ONE_MORE", value: "v" });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("secrets_full");
    // Replacing one in place is still fine.
    const replaced = await call(t, ada, "PUT", `${repo}/secrets/K1`, { value: "w" });
    expect(replaced.status).toBe(200);
  });

  test("removed, are gone", async () => {
    const ada = await as("ada");
    await call(t, ada, "POST", `${env()}/secrets`, { name: "STRIPE_SECRET_KEY", value: "sk_x" });
    const removed = await call(t, ada, "DELETE", `${env()}/secrets/STRIPE_SECRET_KEY`);
    expect(removed.status).toBe(200);
    expect(removed.body.environment.secrets.map((s: { name: string }) => s.name)).toEqual([
      "DATABASE_URL",
    ]);
    const again = await call(t, ada, "DELETE", `${env()}/secrets/STRIPE_SECRET_KEY`);
    expect(again.status).toBe(404);
  });
});

describe("rebuild", () => {
  test("anyone who can push asks for one; it is kept for the repo's next start", async () => {
    const refused = await call(t, await as("cy"), "POST", `${env()}/rebuild`);
    expect(refused.status).toBe(403);

    const asked = await call(t, await as("ben"), "POST", `${env()}/rebuild`);
    expect(asked.status).toBe(202);
    expect(asked.body.canManageSecrets).toBe(false);
    expect(asked.body.canRebuild).toBe(true);
    await t.backgroundDone();
    const read = await call(t, await as("cy"), "GET", env());
    expect(read.body.environment.base.rebuild).toEqual({
      requestedAt: new Date(t.clock.now()).toISOString(),
      waiting: false,
    });
    expect(read.body.canRebuild).toBe(false);
  });
});

describe("a sandbox's environment", () => {
  const KEY = "sk-ant-api03-ada-environment-key-0000000";

  beforeAll(async () => {
    t.anthropic.keys.add(KEY);
    const connected = await call(t, await as("ada"), "POST", "/v1/claude/api-key", { key: KEY });
    expect(connected.status).toBe(200);
    await t.backgroundDone();
  });

  /** What the provider was given, and the secrets the runner unpacks from it for the agent. */
  async function started(scratch = false) {
    const design = await designIn(t, ws, "ada", sampleDoc(), scratch ? "scratch" : "repo");
    const said = await call(t, await as("ada"), "POST", `/v1/designs/${design.id}/messages`, {
      text: "Make the footer darker",
    });
    expect(said.status).toBe(201);
    await t.backgroundDone();
    const sandbox = await getLiveSandbox(t.db, design.id);
    const given = t.sandbox.env(sandbox!.providerId!);
    return { given, secrets: decodeRepoSecrets(given[REPO_SECRETS_VARIABLE]) };
  }

  test("carries the repo's secrets beside Ponzu's own and the one Claude credential", async () => {
    const { given, secrets } = await started();
    expect(secrets).toEqual({ DATABASE_URL });
    expect(given.ANTHROPIC_API_KEY).toBe(KEY);
    expect(given.PONZU_DESIGN_ID).toBeString();
    expect(given.PONZU_RUNNER_TOKEN).toBeString();
    // Never as variables of the runner's own, and another repo's are not its.
    expect(Object.keys(given).toSorted()).toEqual([
      "ANTHROPIC_API_KEY",
      "PONZU_API_URL",
      "PONZU_DESIGN_ID",
      REPO_SECRETS_VARIABLE,
      "PONZU_RUNNER_TOKEN",
    ]);
  });

  test("carry any bytes, in a variable a shell can source as it is", async () => {
    const ada = await as("ada");
    const hostile = 'line one\nit\'s $(touch /tmp/pwned) `id` "q" \\ ünï';
    const added = await call(t, ada, "POST", `${env()}/secrets`, {
      name: "HOSTILE",
      value: hostile,
    });
    expect(added.status).toBe(201);
    const { given, secrets } = await started();
    expect(secrets.HOSTILE).toBe(hostile);
    expect(given[REPO_SECRETS_VARIABLE]).toMatch(/^[A-Za-z0-9_:+/=,]+$/);
    await call(t, ada, "DELETE", `${env()}/secrets/HOSTILE`);
  });

  test("leaves out what is not allowed or cannot be opened, and still starts", async () => {
    const sealed = await vault.seal(
      "https://evil.example",
      secretBinding(ws.repo.id, "ANTHROPIC_BASE_URL"),
    );
    await t.db.execute(
      `insert into repo_secrets (repo_id, name, encrypted_value, value_bytes)
       values ('${ws.repo.id}', 'ANTHROPIC_BASE_URL', '${sealed}', 20),
              ('${ws.repo.id}', 'BROKEN', 'pzv1.nokey.AAAA.AAAA', 4)`,
    );
    const { given, secrets } = await started();
    expect(secrets).toEqual({ DATABASE_URL });
    expect(given.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(t.logs.some((line) => line.event === "repo_secrets_skipped")).toBe(true);
    await t.db.execute(`delete from repo_secrets where name in ('ANTHROPIC_BASE_URL', 'BROKEN')`);
  });

  test("a Scratch design has no repo, and so no secrets", async () => {
    const { given } = await started(true);
    expect(given[REPO_SECRETS_VARIABLE]).toBeUndefined();
    expect(given.ANTHROPIC_API_KEY).toBe(KEY);
  });
});
