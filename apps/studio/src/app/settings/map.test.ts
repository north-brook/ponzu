import { describe, expect, test } from "bun:test";
import { createFakeBackend } from "@ponzu/client/testing";
import { connectionLine } from "../../cloud/claude.ts";
import { billedUsd, usageLine } from "../../cloud/settings/billing.ts";
import { roleEdit } from "../../cloud/settings/members.ts";
import {
  hasIphone,
  installationUrl,
  toConnection,
  toEnvironment,
  toInstallation,
  toMembers,
  toPingDevices,
  toTeamUsage,
  toUsage,
} from "./map.ts";

/** A team with an owner on GitHub, an admin Ponzu made, and a member; and Maya's own account. */
function team() {
  const backend = createFakeBackend();
  const owner = backend.addPerson({ login: "ines", name: "Ines Ruiz" });
  const maya = backend.addPerson({ login: "maya", name: "Maya Ortiz" });
  const sam = backend.addPerson({ login: "sam", name: "Sam Lee" });
  const ws = backend.addWorkspace({
    login: "north-brook",
    name: "Northbrook",
    members: { [owner.id]: "admin", [maya.id]: "admin", [sam.id]: "member" },
    owners: [owner.id],
    repos: [{ name: "site" }],
  });
  const own = backend.addWorkspace({
    login: "maya",
    kind: "personal",
    members: { [maya.id]: "admin" },
  });
  return { backend, owner, maya, sam, ws, own, api: backend.connect(maya).api };
}

describe("Members", () => {
  test("the owner on GitHub is locked as an admin; the last other admin is too", async () => {
    const { api, ws, owner, maya, sam } = team();
    const members = toMembers(await api.workspaces.get(ws.id));
    const of = (id: string) => members.find((m) => m.person.id === id)!;
    expect([of(owner.id).owner, of(maya.id).owner]).toEqual([true, false]);
    expect(roleEdit(of(owner.id), members, true)).toEqual({ editable: false, reason: "owner" });
    expect(roleEdit(of(sam.id), members, true)).toEqual({ editable: true });

    await api.workspaces.setRole(ws.id, sam.id, "admin");
    await api.workspaces.setRole(ws.id, maya.id, "member");
    const after = toMembers(await api.workspaces.get(ws.id));
    // A member reads roles; nothing is offered to change.
    expect(roleEdit(after.find((m) => m.person.id === sam.id)!, after, false)).toEqual({
      editable: false,
      reason: "not_admin",
    });
  });

  test("the API refuses to demote an owner, and says why in words for people", async () => {
    const { api, ws, owner } = team();
    const refused = await api.workspaces.setRole(ws.id, owner.id, "member").catch((e) => e);
    expect([refused.code, refused.message]).toEqual([
      "owner_is_admin",
      "They own it on GitHub, so they're an admin.",
    ]);
  });
});

describe("GitHub", () => {
  test("installed, suspended, and the way to the installation's settings", async () => {
    const { backend, api, ws, own } = team();
    const view = await api.workspaces.get(ws.id);
    expect(toInstallation(view)).toMatchObject({ state: "installed", accountLogin: "north-brook" });
    expect(installationUrl(view)).toStartWith(
      "https://github.com/organizations/north-brook/settings/installations/",
    );
    expect(installationUrl(await api.workspaces.get(own.id))).toStartWith(
      "https://github.com/settings/installations/",
    );
    backend.suspend(ws.id);
    expect(toInstallation(await api.workspaces.get(ws.id)).state).toBe("suspended");
  });
});

describe("Agents", () => {
  test("a subscription and a key, as the Connected row says them", async () => {
    const { backend, api, maya } = team();
    backend.claude.connect(maya.id, "subscription");
    const subscription = toConnection((await api.claude.get()).account!);
    expect([subscription.method, subscription.planLabel, subscription.keyHint]).toEqual([
      "subscription",
      null,
      null,
    ]);
    expect(connectionLine(subscription)).toStartWith("Claude subscription · connected");

    await api.claude.connectApiKey("sk-ant-api03-abcdefghijklmnop4f2a");
    const key = toConnection((await api.claude.get()).account!);
    expect(connectionLine(key)).toStartWith("Anthropic API key · sk-ant-…4f2a · connected");
  });
});

describe("Notifications", () => {
  test("only iPhones are where pings go, each named; one signed in passes the setup's step", async () => {
    const { api } = team();
    expect(hasIphone(await api.notifications.get())).toBe(false);
    await api.devices.register({
      platform: "macos",
      pushToken: "aa",
      pushEnvironment: "production",
      installId: "mac",
    });
    await api.devices.register({
      platform: "ios",
      pushToken: "bb",
      pushEnvironment: "production",
      installId: "phone",
      name: null,
    });
    const answer = await api.notifications.get();
    expect(hasIphone(answer)).toBe(true);
    expect(toPingDevices(answer).map((d) => d.name)).toEqual(["iPhone"]);
  });
});

describe("Environments", () => {
  test("a rebuild asked for says it happens at the next start", async () => {
    const { backend, api, ws } = team();
    const repoId = ws.repos[0]!.id;
    backend.settings.setBase(repoId, { status: "ready", builtAt: new Date().toISOString() });
    expect(toEnvironment((await api.environments.get(repoId)).environment).base.status).toBe(
      "ready",
    );
    const asked = await api.environments.rebuild(repoId);
    expect(toEnvironment(asked.environment).base.status).toBe("requested");
  });
});

describe("Plan and usage", () => {
  test("the pooled free credits come off first; a member sees only their own use", async () => {
    const { backend, api, ws, maya, sam } = team();
    backend.settings.use(ws.id, maya.id, 250);
    backend.settings.use(ws.id, sam.id, 150);
    const answer = await api.usage.get(ws.id);
    const usage = toUsage(answer);
    // Three people, 100 free each: 400 used, 300 free, 100 billed at $0.10.
    expect([usage.freeCredits, usage.usedCredits, billedUsd(usage)]).toEqual([300, 400, 10]);
    expect(usage.card).toBeNull();
    // Nothing is billed while billing isn't set up: the line says so, not a billing date.
    expect(usage.notBilled).toBe(true);
    expect(usageLine(usage, { name: "Northbrook", people: 3 })).toBe(
      "this month for Northbrook · 3 people · 400 credits · not billed yet",
    );
    expect(toTeamUsage(answer, "Northbrook").byPerson?.map((p) => p.usedCredits)).toEqual([
      250, 150, 0,
    ]);

    const asSam = backend.connect(sam).api;
    const theirs = toTeamUsage(await asSam.usage.get(ws.id), "Northbrook");
    expect([theirs.byPerson, theirs.mine.usedCredits]).toEqual([null, 150]);
  });
});
