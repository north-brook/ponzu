import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import {
  claudeAccounts,
  createCanvas,
  githubUserTokens,
  repoSecrets,
  sandboxes,
  saveGithubUserToken,
  upsertRepos,
  upsertUser,
  upsertWorkspace,
} from "@ponzu/db";
import { createTestDb } from "@ponzu/db/testing";
import { countSealedUnderOldKeys, resealAll } from "./reseal.ts";
import { type Binding, createVault, generateVaultKey, type Vault } from "./vault.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
afterAll(() => db.$client.close());

const A = generateVaultKey();
const B = generateVaultKey();
const C = generateVaultKey();
const withA = createVault({ key: A });
const rotated = createVault({ key: B, oldKeys: [A] });
const onlyB = createVault({ key: B });

/** Each stored secret and where it lives, to open every one again at the end. */
const stored: { binding: Binding; plaintext: string }[] = [];
let userId = "";
let repoId = "";
const MANY = 205;

beforeAll(async () => {
  db = await createTestDb();
  const user = await upsertUser(db, {
    workosUserId: "user_reseal",
    githubUserId: 41,
    githubLogin: "maya",
    name: "Maya",
    email: "maya@example.com",
    avatarUrl: null,
  });
  const other = await upsertUser(db, {
    workosUserId: "user_reseal_2",
    githubUserId: 42,
    githubLogin: "ines",
    name: "Ines",
    email: "ines@example.com",
    avatarUrl: null,
  });
  userId = user.id;
  const workspace = await upsertWorkspace(db, {
    githubAccountId: 43,
    githubLogin: "north-brook",
    kind: "org",
    name: "north-brook",
    avatarUrl: null,
    installationId: 43,
    repositorySelection: "all",
    installedByUserId: null,
  });
  const [repo] = await upsertRepos(db, {
    workspaceId: workspace.id,
    repos: [
      {
        githubRepoId: 44,
        fullName: "north-brook/fernwood",
        defaultBranch: "main",
        private: true,
        pushedAt: null,
      },
    ],
  });
  repoId = repo!.id;
  const canvas = await createCanvas(db, {
    workspaceId: workspace.id,
    repoId: null,
    ownerId: user.id,
    claudeAccountId: null,
    name: "Lisbon",
    branch: null,
    doc: emptyDoc("Lisbon"),
  });

  const seal = async (binding: Binding, plaintext: string) => {
    stored.push({ binding, plaintext });
    return withA.seal(plaintext, binding);
  };
  await db.insert(githubUserTokens).values([
    {
      userId: user.id,
      encryptedAccessToken: await seal(
        { column: "github_user_tokens.access_token", row: user.id },
        "ghu_maya_access",
      ),
      encryptedRefreshToken: await seal(
        { column: "github_user_tokens.refresh_token", row: user.id },
        "ghr_maya_refresh",
      ),
    },
    {
      userId: other.id,
      encryptedAccessToken: await seal(
        { column: "github_user_tokens.access_token", row: other.id },
        "ghu_ines_access",
      ),
      encryptedRefreshToken: null,
    },
  ]);
  await db.insert(claudeAccounts).values({
    id: "cla_maya",
    userId: user.id,
    kind: "api_key",
    encryptedCredential: await seal(
      { column: "claude_accounts.encrypted_credential", row: "cla_maya" },
      "sk-ant-maya",
    ),
  });
  await db.insert(sandboxes).values({
    canvasId: canvas.id,
    state: "asleep",
    encryptedPortToken: await seal(
      { column: "sandboxes.encrypted_port_token", row: canvas.id },
      "port_token_lisbon",
    ),
  });
  // More than one page of repo secrets, so the walk has to page.
  const secrets = [];
  for (let i = 0; i < MANY; i++) {
    const name = `SECRET_${String(i).padStart(3, "0")}`;
    secrets.push({
      repoId,
      name,
      encryptedValue: await seal(
        { column: "repo_secrets.encrypted_value", row: `${repoId}/${name}` },
        `value ${i}`,
      ),
    });
  }
  // Three that cannot be sealed again: one copied from another row, so its binding fails; one
  // sealed with a key nobody holds; and one that is not a vault value at all.
  secrets.push(
    { repoId, name: "MOVED", encryptedValue: secrets[0]!.encryptedValue },
    {
      repoId,
      name: "LOST_KEY",
      encryptedValue: await createVault({ key: C }).seal("lost", {
        column: "repo_secrets.encrypted_value",
        row: `${repoId}/LOST_KEY`,
      }),
    },
    { repoId, name: "GARBLED", encryptedValue: "not a vault value" },
  );
  await db.insert(repoSecrets).values(secrets);
});

/** Every sealed value in the database, by where it is. */
async function snapshot() {
  const [tokens, accounts, boxes, secrets] = await Promise.all([
    db.select().from(githubUserTokens),
    db.select().from(claudeAccounts),
    db.select().from(sandboxes),
    db.select().from(repoSecrets),
  ]);
  return {
    tokens: tokens.map((row) => [row.userId, row.encryptedAccessToken, row.encryptedRefreshToken]),
    accounts: accounts.map((row) => [row.id, row.encryptedCredential]),
    boxes: boxes.map((row) => [row.canvasId, row.encryptedPortToken]),
    secrets: secrets.map((row) => [row.name, row.encryptedValue]).sort(),
  };
}

async function sealedAt({ column, row }: Binding): Promise<string> {
  const [table, field] = column.split(".") as [string, string];
  if (table === "github_user_tokens") {
    const found = (await db.select().from(githubUserTokens)).find((r) => r.userId === row)!;
    return field === "access_token" ? found.encryptedAccessToken : found.encryptedRefreshToken!;
  }
  if (table === "claude_accounts") {
    return (await db.select().from(claudeAccounts)).find((r) => r.id === row)!.encryptedCredential!;
  }
  if (table === "sandboxes") {
    return (await db.select().from(sandboxes)).find((r) => r.canvasId === row)!.encryptedPortToken!;
  }
  return (await db.select().from(repoSecrets)).find((r) => `${r.repoId}/${r.name}` === row)!
    .encryptedValue;
}

test("a dry run reports what it would seal again and writes nothing", async () => {
  const before = await snapshot();
  const report = await resealAll({ db, vault: rotated }, { dryRun: true });
  expect(report.dryRun).toBe(true);
  expect(report.counts.reduce((sum, { resealed }) => sum + resealed, 0)).toBe(stored.length);
  expect(await snapshot()).toEqual(before);
});

test("after a rotation, a run seals every value again so the new key alone opens it", async () => {
  const { current, old } = await rotated.keyIds();
  const [idA] = old as [string];
  const idC = (await createVault({ key: C }).keyIds()).current;
  expect(await countSealedUnderOldKeys({ db, vault: rotated })).toBe(stored.length + 3);

  const report = await resealAll({ db, vault: rotated });

  expect(report.currentKeyId).toBe(current);
  expect(report.counts).toEqual([
    {
      binding: "github_user_tokens.access_token",
      keyId: idA,
      resealed: 2,
      changed: 0,
      failed: 0,
    },
    {
      binding: "github_user_tokens.refresh_token",
      keyId: idA,
      resealed: 1,
      changed: 0,
      failed: 0,
    },
    // Ordered by key id; "?" is the malformed value's.
    ...[
      { binding: "repo_secrets.encrypted_value", keyId: "?", resealed: 0, changed: 0, failed: 1 },
      {
        binding: "repo_secrets.encrypted_value",
        keyId: idA,
        resealed: MANY,
        changed: 0,
        failed: 1,
      },
      { binding: "repo_secrets.encrypted_value", keyId: idC, resealed: 0, changed: 0, failed: 1 },
    ].sort((a, b) => a.keyId.localeCompare(b.keyId)),
    {
      binding: "claude_accounts.encrypted_credential",
      keyId: idA,
      resealed: 1,
      changed: 0,
      failed: 0,
    },
    { binding: "sandboxes.encrypted_port_token", keyId: idA, resealed: 1, changed: 0, failed: 0 },
  ]);
  expect(
    report.failures.map(({ row, keyId, reason }) => [row.replace(`${repoId}/`, ""), keyId, reason]),
  ).toEqual([
    ["GARBLED", "?", "malformed"],
    ["LOST_KEY", idC, "key_not_held"],
    ["MOVED", idA, "does_not_open"],
  ]);

  for (const { binding, plaintext } of stored) {
    expect(await onlyB.open(await sealedAt(binding), binding)).toBe(plaintext);
  }
  // Only the three that could not be sealed again are still under another key.
  expect(await countSealedUnderOldKeys({ db, vault: rotated })).toBe(3);

  // The report carries no value, sealed or open.
  const text = JSON.stringify(report);
  for (const { binding, plaintext } of stored) {
    expect(text).not.toContain(plaintext);
    expect(text).not.toContain((await sealedAt(binding)).split(".")[3]!);
  }
});

test("a second run changes nothing, and reports the same three it cannot seal", async () => {
  const before = await snapshot();
  const report = await resealAll({ db, vault: rotated });
  expect(report.counts.reduce((sum, { resealed }) => sum + resealed, 0)).toBe(0);
  expect(report.counts.reduce((sum, { changed }) => sum + changed, 0)).toBe(0);
  expect(report.failures.map(({ reason }) => reason)).toEqual([
    "malformed",
    "key_not_held",
    "does_not_open",
  ]);
  expect(await snapshot()).toEqual(before);
});

test("a value the API rewrites between the read and the write is left as the API wrote it", async () => {
  const binding = { column: "github_user_tokens.access_token", row: userId };
  const D = generateVaultKey();
  // Rotate again, to D, and have "the API" store a fresh token mid-run.
  const again = createVault({ key: D, oldKeys: [B] });
  let fresh = "";
  const racing: Vault = {
    ...again,
    async seal(plaintext, where) {
      if (where.column === binding.column && where.row === binding.row && !fresh) {
        fresh = await again.seal("ghu_maya_refreshed", binding);
        // What a sign-in does: a new pair, sealed with the current key.
        await saveGithubUserToken(db, {
          userId,
          encryptedAccessToken: fresh,
          accessTokenExpiresAt: null,
          encryptedRefreshToken: null,
          refreshTokenExpiresAt: null,
        });
      }
      return again.seal(plaintext, where);
    },
  };
  const report = await resealAll({ db, vault: racing });
  const access = report.counts.find(({ binding: b }) => b === binding.column)!;
  expect(access.changed).toBe(1);
  expect(access.resealed).toBe(1);
  expect(await sealedAt(binding)).toBe(fresh);
  expect(await createVault({ key: D }).open(fresh, binding)).toBe("ghu_maya_refreshed");
});
