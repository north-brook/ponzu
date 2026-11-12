import { afterAll, beforeAll, expect, test } from "bun:test";
import { claudeAccounts, upsertMembership, upsertWorkspace } from "@ponzu/db";
import { createTestApp, type TestApp } from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const workspace = (githubAccountId: number, login: string, kind: "personal" | "org") =>
  upsertWorkspace(t.db, {
    githubAccountId,
    githubLogin: login,
    kind,
    name: login,
    avatarUrl: null,
    installationId: githubAccountId * 10,
    repositorySelection: "selected",
    installedByUserId: null,
  });

test("someone who has only signed in: their profile, and nothing set up yet", async () => {
  const person = await t.signInAs({ login: "newcomer", name: "New Comer" });

  const response = await t.app.request("/v1/me", { headers: person.headers });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    user: {
      id: person.userId,
      githubLogin: "newcomer",
      name: "New Comer",
      email: "newcomer@example.com",
      avatarUrl: "https://avatars.example/newcomer",
    },
    onboarding: { whereConfirmedAt: null, iphoneStepSeenAt: null },
    claudeAccount: null,
    workspaces: [],
    // The test app sends pings (its push fake is on) and has every other switch off.
    features: { billing: "off", push: true, email: false },
  });
});

test("the switches an app shows things by, and none of the API's own", async () => {
  const switched = await createTestApp({
    push: false,
    features: { billing: "observe", email: true, maintenance: "wakes_paused", repoBases: true },
  });
  try {
    const person = await switched.signInAs({ login: "switches" });
    const body = await (await switched.app.request("/v1/me", { headers: person.headers })).json();
    expect(body.features).toEqual({ billing: "observe", push: false, email: true });
  } finally {
    await switched.close();
  }
});

test("someone set up: their workspaces with roles, and their Claude account without its credential", async () => {
  const person = await t.signInAs({ login: "maya" });
  const other = await t.signInAs({ login: "ines" });
  const [own, org, theirs] = await Promise.all([
    workspace(501, "maya", "personal"),
    workspace(502, "north-brook", "org"),
    workspace(503, "elsewhere", "org"),
  ]);
  await upsertMembership(t.db, { workspaceId: own.id, userId: person.userId, role: "admin" });
  await upsertMembership(t.db, { workspaceId: org.id, userId: person.userId, role: "member" });
  await upsertMembership(t.db, { workspaceId: theirs.id, userId: other.userId, role: "admin" });
  await t.db.insert(claudeAccounts).values({
    id: "cla_maya",
    userId: person.userId,
    kind: "subscription",
    encryptedCredential: "pzv1.sealed.claude.credential",
    email: "maya@example.com",
    expiresAt: new Date(t.clock.now() + 10 * 24 * 3600_000),
  });

  const response = await t.app.request("/v1/me", { headers: person.headers });

  const text = await response.text();
  const body = JSON.parse(text);
  expect(body.claudeAccount).toEqual({
    kind: "subscription",
    status: "connected",
    label: "Claude subscription",
    email: "maya@example.com",
    connectedAt: expect.any(String),
    expiresAt: new Date(t.clock.now() + 10 * 24 * 3600_000).toISOString(),
    // Ten days left: time to sign in again.
    expiresSoon: true,
    limitedUntil: null,
  });
  expect(text).not.toContain("sealed");
  expect(
    body.workspaces.sort((a: any, b: any) => a.githubLogin.localeCompare(b.githubLogin)),
  ).toEqual([
    {
      id: own.id,
      githubLogin: "maya",
      name: "maya",
      kind: "personal",
      avatarUrl: null,
      role: "admin",
      installed: true,
      suspended: false,
    },
    {
      id: org.id,
      githubLogin: "north-brook",
      name: "north-brook",
      kind: "org",
      avatarUrl: null,
      role: "member",
      installed: true,
      suspended: false,
    },
  ]);
  // Nothing stored about the person that the shape does not name gets out.
  for (const kept of [
    "pzv1",
    "credential",
    "installationId",
    "workosUserId",
    "githubUserId",
    "ping",
  ]) {
    expect(text).not.toContain(kept);
  }
});

const recordStep = (headers: Record<string, string>, step: string) =>
  t.app.request("/v1/me/onboarding", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ step }),
  });

test("a guided setup step, once recorded, stays done as it was first done, on every device", async () => {
  const person = await t.signInAs({ login: "stepper" });

  const where = await recordStep(person.headers, "where");
  expect(where.status).toBe(200);
  const first = (await where.json()) as { whereConfirmedAt: string; iphoneStepSeenAt: null };
  expect(first.iphoneStepSeenAt).toBeNull();
  expect(first.whereConfirmedAt).toBe(new Date(t.clock.now()).toISOString());

  t.clock.advance(60_000);
  const again = (await (await recordStep(person.headers, "where")).json()) as typeof first;
  expect(again.whereConfirmedAt).toBe(first.whereConfirmedAt);

  await recordStep(person.headers, "iphone");
  const me = (await (await t.app.request("/v1/me", { headers: person.headers })).json()) as {
    onboarding: unknown;
  };
  expect(me.onboarding).toEqual({
    whereConfirmedAt: first.whereConfirmedAt,
    iphoneStepSeenAt: new Date(t.clock.now()).toISOString(),
  });
});

test("only the two steps that leave no other trace can be recorded", async () => {
  const person = await t.signInAs({ login: "skipper" });
  const response = await recordStep(person.headers, "claude");
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    "invalid_request",
  );
});
