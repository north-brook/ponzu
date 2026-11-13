import { afterEach, describe, expect, test } from "bun:test";
import { emailRecipient, insertNotifications } from "@ponzu/db";
import { runCronSteps } from "../cron/steps.ts";
import { call, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

/*
 * Settings › Notifications and email (docs/cloud.md, "Email"): with RESEND_API_KEY unset, as in
 * production today, `/v1/me/notifications` answers and takes exactly what it did before email had
 * more than one kind. With the key, it answers the people-joined and recap switches and whether
 * people-joined could reach the person.
 */

const opened: TestApp[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
});

async function app(mail: boolean) {
  const t = await createTestApp({ mail });
  opened.push(t);
  return t;
}

/** The answer's shape before E3: these keys, and no others. */
const PREFS_BEFORE = ["emailDigest", "needsYou", "prReady", "replies", "teammateComments"];
const EMAIL_BEFORE = ["address", "available"];

describe("with email off", () => {
  test("the answer is what it was: no new switch, no new field", async () => {
    const t = await app(false);
    const ws = await workspaceWithRepo(t, { maya: "admin" });
    const maya = ws.people.maya!;
    const got = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(got.status).toBe(200);
    expect(Object.keys(got.body.prefs).sort()).toEqual(PREFS_BEFORE);
    expect(Object.keys(got.body.email).sort()).toEqual(EMAIL_BEFORE);
    expect(got.body.email.available).toBe(false);
    expect(Object.keys(got.body).sort()).toEqual([
      "badge",
      "devices",
      "email",
      "prefs",
      "timeZone",
    ]);
  });

  test("a change to a switch it cannot send is not taken, and the answer is unchanged", async () => {
    const t = await app(false);
    const ws = await workspaceWithRepo(t, { maya: "admin" });
    const maya = ws.people.maya!;
    const patched = await call(t, maya.headers, "PATCH", "/v1/me/notifications", {
      emailTeam: false,
      emailRecap: false,
      replies: false,
    });
    expect(patched.status).toBe(200);
    expect(Object.keys(patched.body.prefs).sort()).toEqual(PREFS_BEFORE);
    expect(patched.body.prefs.replies).toBe(false);
    // Nothing new written: both switches keep their defaults.
    const row = await emailRecipient(t.db, maya.userId);
    expect({ team: row!.emailTeam, recap: row!.emailRecap }).toEqual({ team: true, recap: true });
  });

  test("no email job is ever recorded, whatever the cron finds", async () => {
    const t = await app(false);
    const ws = await workspaceWithRepo(t, { maya: "admin" });
    const maya = ws.people.maya!;
    // Someone who turned the daily email on, with something to say, at 9:00 where they are.
    await call(t, maya.headers, "PATCH", "/v1/me/notifications", {
      emailDigest: true,
      timeZone: "UTC",
    });
    await insertNotifications(t.db, {
      now: new Date(t.clock.now()),
      rows: [
        {
          userId: maya.userId,
          workspaceId: ws.id,
          canvasId: null,
          kind: "billing_cap_warning",
          dedupeKey: "billing:test",
          title: "ws",
          body: "Your workspace has used 80% of this month's $100 cap.",
          link: { open: "usage" },
          muted: false,
        },
      ],
    });
    t.clock.advance(9 * 60 * 60_000);
    const answer = await runCronSteps(t.deps, new Date(t.clock.now()));
    expect(answer.steps.digests).toEqual({ due: 0, recorded: 0 });
    await t.backgroundDone();
    expect(t.mail.sent).toEqual([]);
    const { rows } = (await t.db.execute(
      "select count(*)::int as n from jobs where kind like 'email.%'",
    )) as unknown as { rows: { n: number }[] };
    expect(rows[0]!.n).toBe(0);
  });
});

describe("with email on", () => {
  test("the switches are answered and taken, and people-joined shows only to an org's admin", async () => {
    const t = await app(true);
    const ws = await workspaceWithRepo(t, { maya: "admin", sam: "write", ola: "admin" });
    const maya = ws.people.maya!;
    const sam = ws.people.sam!;
    const ola = ws.people.ola!;
    // Maya reaches the organisation on GitHub as a member. Ola is an outside collaborator made
    // an admin in Ponzu: people-joined never reaches her, so its switch is not hers to see.
    await t.db.execute(
      `update memberships set github_access = 'member' where user_id = '${maya.userId}'`,
    );
    const hers = await call(t, ola.headers, "GET", "/v1/me/notifications");
    expect(hers.body.email.teamAvailable).toBe(false);

    const got = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(got.body.prefs).toMatchObject({ emailDigest: false, emailTeam: true, emailRecap: true });
    expect(got.body.email).toEqual({
      address: expect.any(String),
      available: true,
      teamAvailable: true,
    });
    // Sam is a member, not an admin.
    const his = await call(t, sam.headers, "GET", "/v1/me/notifications");
    expect(his.body.email.teamAvailable).toBe(false);

    const patched = await call(t, maya.headers, "PATCH", "/v1/me/notifications", {
      emailTeam: false,
      emailRecap: false,
    });
    expect(patched.body.prefs).toMatchObject({ emailTeam: false, emailRecap: false });
    const row = await emailRecipient(t.db, maya.userId);
    expect({ team: row!.emailTeam, recap: row!.emailRecap }).toEqual({
      team: false,
      recap: false,
    });
  });
});
