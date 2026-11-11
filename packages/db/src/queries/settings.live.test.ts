// The Settings statements once each on a real Postgres, through every driver that reaches one:
// they build their answers in json, and drivers disagree about everything else. The API's route
// tests run them on PGlite. Runs only when PONZU_TEST_DATABASE_URL is set (see ../live.ts).
import { afterAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { describeLive } from "../live.ts";
import { anonymiseUser, deleteUser, planAccountDeletion } from "./account-deletion.ts";
import { upsertMembership } from "./accounts.ts";
import { createDesign } from "./designs.ts";
import {
  addRepoSecret,
  deleteRepoSecret,
  getRepoEnvironment,
  listDesignSecrets,
  listWorkspaceEnvironments,
  markBaseForRebuild,
  replaceRepoSecret,
} from "./environments.ts";
import { registerDevice, setPingPrefs, updateDevice } from "./notifications.ts";
import { recordReachableRepos } from "./repo-access.ts";
import { postMessage } from "./thread.ts";
import { recordUsage } from "./usage.ts";
import { readWorkspaceUsage, setMonthlyCap } from "./workspace-usage.ts";

describeLive("settings on a real Postgres", ({ db, close }) => {
  afterAll(close);

  test("ping toggles and devices", async () => {
    const user = await seedUser(db, "pinged");
    expect(await setPingPrefs(db, { userId: user.id, prefs: { teammateComments: true } })).toEqual(
      { needsYou: true, replies: true, prReady: true, teammateComments: true, emailDigest: false },
    );
    const token = `${Date.now().toString(16)}`.padStart(64, "d");
    const first = await registerDevice(db, {
      userId: user.id,
      platform: "ios",
      pushToken: token,
      pushEnvironment: "production",
      name: "iPhone",
      appVersion: "1.0.0",
      pingsBlocked: false,
    });
    expect(first.created).toBe(true);
    expect(first.device.lastSeenAt).toBeInstanceOf(Date);
    const again = await registerDevice(db, { ...first.device, pingsBlocked: true });
    expect(again).toMatchObject({ created: false, device: { id: first.device.id, pingsBlocked: true } });
    const changed = await updateDevice(db, {
      userId: user.id,
      id: first.device.id,
      changes: { pingsEnabled: false },
    });
    expect(changed?.pingsEnabled).toBe(false);
  });

  test("a repo's environment and secrets", async () => {
    const user = await seedUser(db, "admin");
    const workspace = await seedWorkspace(db, "envs");
    const repo = await seedRepo(db, workspace.id, "envs/fernwood");
    await recordReachableRepos(db, {
      userId: user.id,
      workspaceId: workspace.id,
      repos: [{ githubRepoId: repo.githubRepoId, permission: "write" }],
      complete: true,
      checkedAt: new Date(),
    });
    const write = {
      repoId: repo.id,
      name: "DATABASE_URL",
      encryptedValue: "pzv1.k.n.c",
      valueBytes: 10,
      userId: user.id,
      now: new Date("2026-11-11T10:00:00Z"),
      limits: { count: 2, totalBytes: 100 },
    };
    expect(await addRepoSecret(db, write)).toBe("added");
    expect(await addRepoSecret(db, write)).toBe("exists");
    expect(await replaceRepoSecret(db, { ...write, valueBytes: 200 })).toBe("full");
    expect(await replaceRepoSecret(db, { ...write, encryptedValue: "pzv1.k.n.d" })).toBe(
      "replaced",
    );
    await markBaseForRebuild(db, { repoId: repo.id, now: new Date("2026-11-11T11:00:00Z") });
    const environment = await getRepoEnvironment(db, { repoId: repo.id, rebuildJob: "x" });
    expect(environment).toMatchObject({
      fullName: "envs/fernwood",
      base: { status: "none", rebuildRequestedAt: new Date("2026-11-11T11:00:00Z") },
      secrets: [{ name: "DATABASE_URL", updatedAt: new Date("2026-11-11T10:00:00Z") }],
    });
    const design = await createDesign(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Env",
      branch: null,
      doc: emptyDoc("Env"),
    });
    expect(await listDesignSecrets(db, design.id)).toEqual([
      { repoId: repo.id, name: "DATABASE_URL", encryptedValue: "pzv1.k.n.d" },
    ]);
    const listed = await listWorkspaceEnvironments(db, {
      workspaceId: workspace.id,
      userId: user.id,
      rebuildJob: "x",
    });
    expect(listed.map((row) => row.repoId)).toEqual([repo.id]);
    expect(await deleteRepoSecret(db, { repoId: repo.id, name: "DATABASE_URL" })).toBe(true);
  });

  test("a period's usage, the cap, and deleting an account", async () => {
    const user = await seedUser(db, "spender");
    const workspace = await seedWorkspace(db, "spend");
    await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role: "member" });
    const design = await createDesign(db, {
      workspaceId: workspace.id,
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Spend",
      branch: null,
      doc: emptyDoc("Spend"),
    });
    await recordUsage(db, {
      id: `live-${design.id}`,
      workspaceId: workspace.id,
      designId: design.id,
      userId: user.id,
      kind: "sandbox",
      seconds: 3600,
      credits: 0,
      costMicrousd: 0,
      payer: "ponzu",
      rateCardVersion: 1,
      occurredAt: new Date("2026-11-10T00:00:00Z"),
      periodStart: new Date("2026-11-09T00:00:00Z"),
    });
    await setMonthlyCap(db, { workspaceId: workspace.id, capCents: 5000 });
    const read = await readWorkspaceUsage(db, {
      workspaceId: workspace.id,
      viewerId: user.id,
      start: new Date("2026-11-09T00:00:00Z"),
      end: new Date("2026-12-09T00:00:00Z"),
      now: new Date("2026-11-11T00:00:00Z"),
    });
    expect(read).toMatchObject({
      current: { version: 1, creditMicrousd: 100_000, sandboxCreditsPerAwakeHour: 5 },
      monthlyCapCents: 5000,
      rows: [{ userId: user.id, designId: design.id, rateCardVersion: 1, seconds: 3600 }],
      people: [{ id: user.id, role: "member" }],
      designs: [{ id: design.id, readable: true }],
    });

    await postMessage(db, {
      designId: design.id,
      userId: user.id,
      item: { text: "hi", from: { id: user.id, name: "Spender", login: "spender" } },
      event: { text: "hi" },
    });
    expect(await planAccountDeletion(db, user.id)).toEqual({
      soleAdminOf: [],
      deleted: [design.id],
      kept: [],
    });
    expect(await anonymiseUser(db, user.id)).toBeGreaterThan(0);
    expect(await deleteUser(db, user.id)).toBe(user.workosUserId);
  });
});
