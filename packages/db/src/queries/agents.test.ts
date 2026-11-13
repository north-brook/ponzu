import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { seedUser } from "../fixtures.ts";
import { agentAuthorizations, agentGrants } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import {
  approveAgentAuthorization,
  consumeAgentCode,
  createAgentAuthorization,
  denyAgentAuthorization,
  getAgentCode,
  getOpenAgentAuthorization,
  issueAgentTokens,
  listAgentGrants,
  registerAgentClient,
  revokeAgentGrant,
  revokeAgentToken,
  useAgentRefreshToken,
  verifyAgentToken,
} from "./agents.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

async function ask(name = "Claude Code") {
  const client = await registerAgentClient(db, {
    name,
    redirectUris: ["http://localhost:4000/callback"],
    metadata: { client_name: name },
  });
  const id = await createAgentAuthorization(db, {
    clientId: client.id,
    redirectUri: "http://localhost:4000/callback",
    codeChallenge: "challenge",
    state: "st",
    scope: null,
    resource: null,
  });
  return { client, id };
}

test("an allowed ask gives one code, traded once for tokens that act as the person", async () => {
  const user = await seedUser(db, "maya");
  const { client, id } = await ask();
  expect(await getOpenAgentAuthorization(db, id)).toMatchObject({ clientName: "Claude Code" });

  const approved = await approveAgentAuthorization(db, {
    id,
    userId: user.id,
    name: "Claude Code",
  });
  expect(approved).toMatchObject({ redirectUri: "http://localhost:4000/callback", state: "st" });
  expect(approved!.code).toMatch(/^pzc_/);
  // Decided: it can't be allowed or refused again.
  expect(await getOpenAgentAuthorization(db, id)).toBeNull();
  expect(await approveAgentAuthorization(db, { id, userId: user.id, name: "x" })).toBeNull();
  expect(await denyAgentAuthorization(db, { id, userId: user.id })).toBeNull();

  expect(await getAgentCode(db, approved!.code)).toMatchObject({
    clientId: client.id,
    grantId: approved!.grantId,
    codeChallenge: "challenge",
  });
  expect(await consumeAgentCode(db, { code: approved!.code, clientId: "agc_other" })).toBeNull();
  const grantId = await consumeAgentCode(db, { code: approved!.code, clientId: client.id });
  expect(grantId).toBe(approved!.grantId);

  const tokens = await issueAgentTokens(db, grantId!);
  expect(tokens.accessToken).toMatch(/^pza_/);
  const owner = await verifyAgentToken(db, tokens.accessToken);
  expect(owner?.user.id).toBe(user.id);
  expect(owner?.grant.name).toBe("Claude Code");
  expect(await verifyAgentToken(db, tokens.refreshToken)).toBeNull();
});

test("a code used twice revokes the grant it made", async () => {
  const user = await seedUser(db, "ines");
  const { client, id } = await ask();
  const approved = await approveAgentAuthorization(db, { id, userId: user.id, name: "Codex" });
  const grantId = await consumeAgentCode(db, { code: approved!.code, clientId: client.id });
  const tokens = await issueAgentTokens(db, grantId!);
  expect(await consumeAgentCode(db, { code: approved!.code, clientId: client.id })).toBeNull();
  expect(await verifyAgentToken(db, tokens.accessToken)).toBeNull();
});

test("a refresh token works once; sent again it revokes the grant", async () => {
  const user = await seedUser(db, "sam");
  const { client, id } = await ask();
  const approved = await approveAgentAuthorization(db, { id, userId: user.id, name: "Codex" });
  const grantId = (await consumeAgentCode(db, { code: approved!.code, clientId: client.id }))!;
  const first = await issueAgentTokens(db, grantId);

  expect(
    await useAgentRefreshToken(db, { refreshToken: first.refreshToken, clientId: "agc_other" }),
  ).toBeNull();
  expect(
    await useAgentRefreshToken(db, { refreshToken: first.refreshToken, clientId: client.id }),
  ).toBe(grantId);
  const second = await issueAgentTokens(db, grantId);
  expect(await verifyAgentToken(db, second.accessToken)).not.toBeNull();

  expect(
    await useAgentRefreshToken(db, { refreshToken: first.refreshToken, clientId: client.id }),
  ).toBeNull();
  expect(await verifyAgentToken(db, second.accessToken)).toBeNull();
});

test("a refused ask answers where to send the agent back, and makes no grant", async () => {
  const user = await seedUser(db, "lee");
  const { id } = await ask();
  expect(await denyAgentAuthorization(db, { id, userId: user.id })).toEqual({
    redirectUri: "http://localhost:4000/callback",
    state: "st",
  });
  expect(await listAgentGrants(db, user.id)).toEqual([]);
});

test("an ask past its time can't be allowed", async () => {
  const user = await seedUser(db, "ola");
  const { id } = await ask();
  await db
    .update(agentAuthorizations)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(agentAuthorizations.id, id));
  expect(await approveAgentAuthorization(db, { id, userId: user.id, name: "x" })).toBeNull();
});

test("revoking a grant, or a token, ends what it held; only its own person can revoke it", async () => {
  const user = await seedUser(db, "kai");
  const other = await seedUser(db, "zoe");
  const { client, id } = await ask();
  const approved = await approveAgentAuthorization(db, { id, userId: user.id, name: "Cursor" });
  const grantId = (await consumeAgentCode(db, { code: approved!.code, clientId: client.id }))!;
  const tokens = await issueAgentTokens(db, grantId);
  expect((await listAgentGrants(db, user.id)).map((grant) => grant.id)).toEqual([grantId]);

  await revokeAgentToken(db, { token: tokens.accessToken, clientId: client.id });
  expect(await verifyAgentToken(db, tokens.accessToken)).toBeNull();
  const fresh = await issueAgentTokens(db, grantId);

  expect(await revokeAgentGrant(db, { userId: other.id, grantId })).toBe(false);
  expect(await revokeAgentGrant(db, { userId: user.id, grantId })).toBe(true);
  expect(await verifyAgentToken(db, fresh.accessToken)).toBeNull();
  expect(await listAgentGrants(db, user.id)).toEqual([]);
  const [row] = await db.select().from(agentGrants).where(eq(agentGrants.id, grantId));
  expect(row?.revokedAt).not.toBeNull();
});
