import { afterEach, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  digestRecipient,
  insertNotifications,
  markNotificationsRead,
  type NewNotification,
  newId,
  recordRepoAccess,
  resolveNeedsYou,
  stampDigestSent,
} from "@ponzu/db";
import { runCronSteps } from "../cron/steps.ts";
import { runDueJobs } from "../jobs/run.ts";
import { call, canvasIn, canvasWithRunner, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_API_URL, type TestApp } from "../testing/index.ts";
import { createVault, generateVaultKey } from "../vault/vault.ts";
import {
  DIGEST_BATCH,
  DIGEST_LINES_PER_GROUP,
  digestEmail,
  digestHref,
  digestKey,
  runDigestJob,
} from "./digest.ts";
import { unsubscribeToken, unsubscribeUser } from "./unsubscribe.ts";

/*
 * The daily email, on the real app with a fake Resend (FakeMail) and a clock that moves only when
 * a test moves it. The clock starts at 2026-01-01 00:00 UTC; Lisbon is on UTC then, and New
 * York five hours behind.
 */

const opened: TestApp[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
});

async function app(options: { mail?: boolean } = { mail: true }) {
  const t = await createTestApp(options);
  opened.push(t);
  return t;
}

/** Move the clock to `iso`, run the minute's cron as Vercel would, then every job it left due. */
async function cronAt(t: TestApp, iso: string) {
  t.clock.advance(new Date(iso).getTime() - t.clock.now());
  const answer = await runCronSteps(t.deps, new Date(t.clock.now()));
  for (let round = 0; round < 10; round++) {
    const { ran } = await runDueJobs(t.deps, `test:${crypto.randomUUID()}`);
    await t.backgroundDone();
    if (ran === 0) break;
  }
  return answer.steps.digests;
}

let logins = 0;

/**
 * A person with the email on in `timeZone`, who owns a canvas they can read, and a teammate.
 * Each call is new people: the same login twice would be the same person.
 */
async function person(t: TestApp, timeZone: string | null = "Europe/Lisbon") {
  const n = ++logins;
  const ws = await workspaceWithRepo(t, { [`maya${n}`]: "admin", [`sam${n}`]: "write" });
  ws.people.maya = ws.people[`maya${n}`]!;
  ws.people.sam = ws.people[`sam${n}`]!;
  const canvas = await canvasIn(t, ws, "maya", sampleDoc());
  const now = new Date(t.clock.now());
  await recordRepoAccess(t.db, [
    { userId: ws.people.maya!.userId, repoId: ws.repo.id, permission: "admin", checkedAt: now },
    { userId: ws.people.sam!.userId, repoId: ws.repo.id, permission: "write", checkedAt: now },
  ]);
  const maya = ws.people.maya!;
  const patch = await call(t, maya.headers, "PATCH", "/v1/me/notifications", {
    emailDigest: true,
    ...(timeZone ? { timeZone } : {}),
  });
  expect(patch.status).toBe(200);
  return { ws, canvas, maya, userId: maya.userId, address: `maya${n}@example.com` };
}

let serial = 0;
/** A row as the pipeline writes it, made at the clock's now. */
async function row(t: TestApp, fields: Partial<NewNotification> & Pick<NewNotification, "userId">) {
  const [made] = await insertNotifications(t.db, {
    now: new Date(t.clock.now()),
    rows: [
      {
        workspaceId: null,
        canvasId: null,
        // Not needs_you: the cron's sweep resolves a needs-you whose question does not exist.
        kind: "reply",
        dedupeKey: `test:${serial++}`,
        title: "Fernwood",
        body: "Ponzu replied to your comment.",
        link: { open: "thread" },
        muted: false,
        ...fields,
      },
    ],
  });
  return made!;
}

/** The email's text with its unsubscribe token, which is random, named. */
const withoutToken = (text: string) => text.replace(/([?&])t=[^&\s]+/g, "$1t=<token>");

describe("off without RESEND_API_KEY", () => {
  test("nothing is found due, nothing is sent, and Settings is told email is not available", async () => {
    const t = await app({ mail: false });
    const { canvas, ws, userId, maya, address } = await person(t);
    await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
    // Asked before the clock moves past the session's life.
    const settings = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(settings.body.email).toEqual({ address, available: false });
    expect(settings.body.prefs.emailDigest).toBe(true);
    expect(await cronAt(t, "2026-01-01T09:00:00Z")).toEqual({ due: 0, recorded: 0 });
    expect(await cronAt(t, "2026-01-01T10:00:00Z")).toEqual({ due: 0, recorded: 0 });
    expect(t.mail.sent).toEqual([]);
  });
});

describe("the daily email", () => {
  test("goes once a local day from 9:00, with the exact subject, lines and headers", async () => {
    const t = await app();
    const { canvas, ws, userId, address } = await person(t);
    await row(t, {
      userId,
      workspaceId: ws.id,
      canvasId: canvas.id,
      link: { open: "thread", questionId: "q_1" },
    });
    t.clock.advance(1000);
    await row(t, {
      userId,
      workspaceId: ws.id,
      canvasId: canvas.id,
      kind: "teammate_comment",
      body: "Sam left 2 comments.",
      link: { open: "comment", pageId: "pg_1", artboardId: "ab_1", commentThreadId: "ct_1" },
      // A toggle that is off still makes the row, muted, and the email carries it.
      muted: true,
    });

    expect(await cronAt(t, "2026-01-01T08:00:00Z")).toEqual({ due: 0, recorded: 0 });
    expect(t.mail.sent).toEqual([]);
    expect(await cronAt(t, "2026-01-01T09:00:00Z")).toEqual({ due: 1, recorded: 1 });
    expect(t.mail.sent).toHaveLength(1);
    const [email] = t.mail.sent;

    const site = `https://ponzu.design/canvases/${canvas.id}`;
    expect(email!.to).toBe(address);
    expect(email!.subject).toBe(`${canvas.name}: 2 things since yesterday`);
    expect(email!.idempotencyKey).toBe(`digest:${userId}:2026-01-01`);
    expect(email!.idempotencyKey).toBe(digestKey(userId, "2026-01-01"));
    expect(withoutToken(email!.text)).toBe(
      [
        "Since yesterday",
        "",
        "Here is what Ponzu told you about in the last day.",
        "",
        canvas.name,
        `Ponzu replied to your comment. ${site}?open=thread&question=q_1`,
        `Sam left 2 comments. ${site}?open=comment&page=pg_1&artboard=ab_1&comment=ct_1`,
        "",
        "You get this email once a day because it is on in Ponzu's Settings.",
        "",
        `Stop these emails ${TEST_API_URL}/v1/email/unsubscribe?t=<token>`,
        "",
        "Northbrook PBC, 169 Madison Ave, Suite 2504, New York, NY 10016",
        "",
      ].join("\n"),
    );
    const unsubscribe = email!.headers["List-Unsubscribe"]!;
    expect(unsubscribe).toMatch(
      new RegExp(`^<${TEST_API_URL}/v1/email/unsubscribe\\?t=usr_[A-Za-z0-9]+\\.pzv1\\.`),
    );
    expect(email!.headers).toEqual({
      "List-Unsubscribe": unsubscribe,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(email!.html).toContain(`href="${site}?open=thread&amp;question=q_1"`);
    expect(email!.html).toContain(unsubscribe.slice(1, -1).replaceAll("&", "&amp;"));

    // The same day: not due again, at any hour.
    expect(await cronAt(t, "2026-01-01T10:00:00Z")).toEqual({ due: 0, recorded: 0 });
    expect(await cronAt(t, "2026-01-01T23:00:00Z")).toEqual({ due: 0, recorded: 0 });
    // The next day before 9:00: not yet.
    expect(await cronAt(t, "2026-01-02T08:00:00Z")).toEqual({ due: 0, recorded: 0 });
    // At 9:00 it is due, and with nothing new in the last day it only stamps the date.
    expect(await cronAt(t, "2026-01-02T09:00:00Z")).toEqual({ due: 1, recorded: 1 });
    expect(t.mail.sent).toHaveLength(1);
    expect((await digestRecipient(t.db, userId))?.digestSentOn).toBe("2026-01-02");
    expect(await cronAt(t, "2026-01-02T10:00:00Z")).toEqual({ due: 0, recorded: 0 });
    expect(t.logs.some((line) => line.event === "digest_empty")).toBe(true);
    // No address, subject or body reaches a log.
    expect(JSON.stringify(t.logs)).not.toContain(address);
    expect(JSON.stringify(t.logs)).not.toContain("replied to your comment");
  });

  test("goes at 9:00 in the person's zone, and in New York's when none was reported", async () => {
    const t = await app();
    const tokyo = await person(t, "Asia/Tokyo");
    await row(t, { userId: tokyo.userId, workspaceId: tokyo.ws.id, canvasId: tokyo.canvas.id });
    // 00:00 UTC is 09:00 in Tokyo.
    expect(await cronAt(t, "2026-01-01T00:00:00Z")).toEqual({ due: 1, recorded: 1 });
    // Someone who never reported a zone, from 19:00 on 31 December in New York.
    const york = await person(t, null);
    await row(t, { userId: york.userId, workspaceId: york.ws.id, canvasId: york.canvas.id });
    // 13:00 UTC is 08:00 on 1 January there.
    expect(await cronAt(t, "2026-01-01T13:00:00Z")).toEqual({ due: 0, recorded: 0 });
    // 14:00 UTC is 09:00 in New York in January.
    expect(await cronAt(t, "2026-01-01T14:00:00Z")).toEqual({ due: 1, recorded: 1 });
    expect(t.mail.sent.map((email) => email.idempotencyKey)).toEqual([
      `digest:${tokyo.userId}:2026-01-01`,
      `digest:${york.userId}:2026-01-01`,
    ]);
  });

  test("none when there is nothing to say: read, resolved, or older than a day", async () => {
    const t = await app();
    const { canvas, ws, userId } = await person(t);
    const now = new Date(t.clock.now());
    const read = await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
    // A muted row read since (its canvas opened) is not news either.
    const mutedRead = await row(t, {
      userId,
      workspaceId: ws.id,
      canvasId: canvas.id,
      muted: true,
    });
    await markNotificationsRead(t.db, { userId, ids: [read.id, mutedRead.id], now, via: "mac" });
    const question = newId("q");
    await row(t, {
      userId,
      workspaceId: ws.id,
      canvasId: canvas.id,
      kind: "needs_you",
      sourceId: question,
    });
    await resolveNeedsYou(t.db, { canvasId: canvas.id, questionIds: [question], now });
    // 31 Dec 08:59 is a day and a minute before the email is due.
    t.clock.advance(new Date("2025-12-31T08:59:00Z").getTime() - t.clock.now());
    await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
    // 1 Jan 09:00: the read and the resolved rows are inside the day, and still say nothing.
    expect(await cronAt(t, "2026-01-01T09:00:00Z")).toEqual({ due: 1, recorded: 1 });
    expect(t.mail.sent).toEqual([]);
    expect((await digestRecipient(t.db, userId))?.digestSentOn).toBe("2026-01-01");
  });

  test("a job for a date already stamped sends nothing", async () => {
    const t = await app();
    const { canvas, ws, userId } = await person(t);
    await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
    await stampDigestSent(t.db, { userId, localDate: "2026-01-01" });
    t.clock.advance(9 * 60 * 60_000);
    await runDigestJob(
      t.deps,
      { userId, localDate: "2026-01-01", until: new Date(t.clock.now()).toISOString() },
      { id: "job_test", kind: "email.digest", payload: {}, attempts: 1, maxAttempts: 5 },
    );
    expect(t.mail.sent).toEqual([]);
  });

  test("keeps a canvas whose kept answer is only old, and drops one taken away since", async () => {
    const t = await app();
    // Both people's kept answers are from midnight; their rows from noon.
    const kept = await person(t);
    const lost = await person(t);
    t.clock.advance(12 * 60 * 60_000);
    await row(t, { userId: kept.userId, workspaceId: kept.ws.id, canvasId: kept.canvas.id });
    await row(t, { userId: lost.userId, workspaceId: lost.ws.id, canvasId: lost.canvas.id });
    // GitHub says, after the row was made, that the second person may no longer see the repo.
    await recordRepoAccess(t.db, [
      {
        userId: lost.userId,
        repoId: lost.ws.repo.id,
        permission: "none",
        checkedAt: new Date(t.clock.now() + 60_000),
      },
    ]);
    // A day and a half on, the first person's answer is 33 hours old: the canvas stays.
    expect(await cronAt(t, "2026-01-02T09:00:00Z")).toEqual({ due: 2, recorded: 2 });
    expect(t.mail.sent.map((email) => email.idempotencyKey)).toEqual([
      `digest:${kept.userId}:2026-01-02`,
    ]);
    expect(t.logs.filter((line) => line.event === "digest_empty")).toMatchObject([
      { userId: lost.userId },
    ]);
  });

  test("drops a canvas the person can no longer read, and keeps billing only for an admin", async () => {
    const t = await app();
    const { canvas, ws, userId } = await person(t);
    await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
    // A canvas in a workspace they are not a member of.
    const other = await workspaceWithRepo(t, { ines: "admin" });
    const elsewhere = await canvasIn(t, other, "ines", { ...sampleDoc(), name: "Not yours" });
    await row(t, { userId, workspaceId: other.id, canvasId: elsewhere.id, title: "Not yours" });
    // Billing: Maya is an admin of her workspace, not of the other.
    await row(t, {
      userId,
      workspaceId: ws.id,
      kind: "billing_cap_warning",
      title: "ws",
      body: "Your workspace has used 80% of this month's $100 cap.",
      link: { open: "usage" },
    });
    await row(t, {
      userId,
      workspaceId: other.id,
      kind: "billing_cap_reached",
      title: "other",
      body: "Someone else's cap.",
      link: { open: "usage" },
    });
    expect(await cronAt(t, "2026-01-01T09:00:00Z")).toEqual({ due: 1, recorded: 1 });
    const [email] = t.mail.sent;
    // The workspace is named for its GitHub account; a billing group reads "<workspace>'s plan".
    const plan = `${ws.github.installation.account.login}'s plan`;
    expect(email!.subject).toBe(`${canvas.name} and ${plan}: 2 things since yesterday`);
    expect(email!.text).not.toContain("Not yours");
    expect(email!.text).not.toContain("Someone else's cap.");
    // The billing line has no link yet: the site's /settings handoff comes with E3.
    expect(email!.text).toContain(
      `${plan}\nYour workspace has used 80% of this month's $100 cap.\n`,
    );
  });

  test("a question's words never reach the email, only the canvas's name and Ponzu's", async () => {
    const t = await app();
    const ws = await workspaceWithRepo(t, { maya: "admin" });
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    await recordRepoAccess(t.db, [
      {
        userId: ws.people.maya!.userId,
        repoId: ws.repo.id,
        permission: "admin",
        checkedAt: new Date(t.clock.now()),
      },
    ]);
    await call(t, ws.people.maya!.headers, "PATCH", "/v1/me/notifications", {
      emailDigest: true,
      timeZone: "Europe/Lisbon",
    });
    const secret = "Ship the launch plan for Project Nightjar";
    const raised = await call(t, runner.headers, "POST", "/v1/runner/questions", {
      id: newId("q"),
      kind: "question",
      payload: {
        questions: [{ header: "Plan", question: secret, options: [], multiSelect: false }],
      },
    });
    expect(raised.status).toBe(200);
    await t.backgroundDone();
    expect(await cronAt(t, "2026-01-01T09:00:00Z")).toEqual({ due: 1, recorded: 1 });
    const [email] = t.mail.sent;
    expect(email!.text).toContain(`${canvas.name}\nPonzu has a question for you. `);
    for (const part of [email!.subject, email!.text, email!.html]) {
      expect(part).not.toContain("Nightjar");
    }
  });

  test("Resend unavailable is tried again with the same key; a refusal is not", async () => {
    const t = await app();
    const { canvas, ws, userId } = await person(t);
    await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
    t.mail.failNext("unavailable");
    expect(await cronAt(t, "2026-01-01T09:00:00Z")).toEqual({ due: 1, recorded: 1 });
    expect(t.mail.sent).toEqual([]);
    // A row made after it was found due waits for tomorrow's: every attempt covers the same day.
    t.clock.advance(2 * 60_000);
    await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id, body: "Later." });
    // The job waits five minutes and goes again.
    await cronAt(t, "2026-01-01T09:05:00Z");
    expect(t.mail.sent.map((email) => email.idempotencyKey)).toEqual([
      `digest:${userId}:2026-01-01`,
    ]);
    expect(t.mail.sent[0]!.subject).toBe(`${canvas.name}: Ponzu replied to your comment`);
    expect(t.mail.sent[0]!.text).not.toContain("Later.");

    // The next day Resend refuses it: logged, the date stamped, and not tried again.
    await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
    t.mail.failNext("rejected");
    expect(await cronAt(t, "2026-01-02T09:00:00Z")).toEqual({ due: 1, recorded: 1 });
    expect(t.logs.filter((line) => line.event === "digest_failed")).toHaveLength(1);
    expect(await cronAt(t, "2026-01-02T10:00:00Z")).toEqual({ due: 0, recorded: 0 });
    expect(t.mail.sent).toHaveLength(1);
  });
});

describe("sending in batches", () => {
  test("the step sends its batch itself, not left behind other jobs, and caps a canvas at ten lines", async () => {
    const t = await app();
    const { canvas, ws, userId } = await person(t);
    for (let n = 0; n < DIGEST_LINES_PER_GROUP + 2; n++) {
      await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
      t.clock.advance(1000);
    }
    t.clock.advance(new Date("2026-01-01T09:00:00Z").getTime() - t.clock.now());
    // The cron's steps alone, and what they left running past the response: no `jobs` claim.
    const answer = await runCronSteps(t.deps, new Date(t.clock.now()));
    expect(answer.steps.digests).toEqual({ due: 1, recorded: 1 });
    await t.backgroundDone();
    expect(t.mail.sent).toHaveLength(1);
    const lines = t.mail.sent[0]!.text.split("\n");
    const rows = lines.filter((line) => line.startsWith("Ponzu replied to your comment. "));
    expect(rows).toHaveLength(DIGEST_LINES_PER_GROUP);
    expect(lines[lines.lastIndexOf(rows.at(-1)!) + 1]).toBe("And 2 more.");
    expect(t.mail.sent[0]!.subject).toBe(`${canvas.name}: 12 things since yesterday`);
  });

  test("a step takes at most a batch, and the next slot takes the rest", async () => {
    const t = await app();
    const people = [];
    for (let n = 0; n < DIGEST_BATCH + 1; n++) people.push(await person(t, "UTC"));
    expect(await cronAt(t, "2026-01-01T09:00:00Z")).toEqual({
      due: DIGEST_BATCH,
      recorded: DIGEST_BATCH,
    });
    // Nobody had anything to say, so each was only stamped; the one left goes five minutes on.
    expect(await cronAt(t, "2026-01-01T09:05:00Z")).toEqual({ due: 1, recorded: 1 });
    expect(await cronAt(t, "2026-01-01T09:10:00Z")).toEqual({ due: 0, recorded: 0 });
    for (const { userId } of people) {
      expect((await digestRecipient(t.db, userId))?.digestSentOn).toBe("2026-01-01");
    }
  });
});

describe("unsubscribing", () => {
  const tokenOf = (email: { headers: Record<string, string> }) =>
    new URL(email.headers["List-Unsubscribe"]!.slice(1, -1)).searchParams.get("t")!;

  test("the email's link turns the email off, as a page, and the toggle shows it", async () => {
    const t = await app();
    const { canvas, ws, userId } = await person(t);
    await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
    await cronAt(t, "2026-01-01T09:00:00Z");
    const token = tokenOf(t.mail.sent[0]!);

    const page = await t.app.request(`/v1/email/unsubscribe?t=${encodeURIComponent(token)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toBeTruthy();
    expect(await page.text()).toContain("You won't get Ponzu's daily email any more.");
    expect((await digestRecipient(t.db, userId))?.emailDigest).toBe(false);

    // Off: the next day nothing is due. Following the link again is the same page.
    await row(t, { userId, workspaceId: ws.id, canvasId: canvas.id });
    expect(await cronAt(t, "2026-01-02T09:00:00Z")).toEqual({ due: 0, recorded: 0 });
    expect(
      (await t.app.request(`/v1/email/unsubscribe?t=${encodeURIComponent(token)}`)).status,
    ).toBe(200);
  });

  test("a mail app's one-click POST turns it off with 204", async () => {
    const t = await app();
    const { userId, maya } = await person(t);
    const token = await unsubscribeToken(t.deps.vault, userId);
    const answer = await t.app.request(`/v1/email/unsubscribe?t=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(answer.status).toBe(204);
    const settings = await call(t, maya.headers, "GET", "/v1/me/notifications");
    expect(settings.body.prefs.emailDigest).toBe(false);
  });

  test("a forged, moved or foreign token is refused and changes nothing", async () => {
    const t = await app();
    const maya = await person(t);
    const sam = maya.ws.people.sam!;
    await call(t, sam.headers, "PATCH", "/v1/me/notifications", { emailDigest: true });
    const real = await unsubscribeToken(t.deps.vault, sam.userId);
    const sealed = real.slice(real.indexOf(".") + 1);
    const foreign = await unsubscribeToken(createVault({ key: generateVaultKey() }), maya.userId);
    const forged = [
      // Sam's sealed part under Maya's id.
      `${maya.userId}.${sealed}`,
      // Another key's token for Maya.
      foreign,
      // Altered, and not a token at all.
      `${real.slice(0, -2)}xx`,
      maya.userId,
      "",
      "usr_x.pzv1.....",
    ];
    for (const token of forged) {
      expect(await unsubscribeUser(t.deps.vault, token)).toBeNull();
      const page = await t.app.request(`/v1/email/unsubscribe?t=${encodeURIComponent(token)}`);
      expect(page.status).toBe(400);
      expect(await page.text()).toContain("This link doesn");
      const post = await t.app.request(`/v1/email/unsubscribe?t=${encodeURIComponent(token)}`, {
        method: "POST",
      });
      expect(post.status).toBe(400);
    }
    expect((await t.app.request("/v1/email/unsubscribe")).status).toBe(400);
    for (const who of [maya.maya, sam]) {
      const settings = await call(t, who.headers, "GET", "/v1/me/notifications");
      expect(settings.body.prefs.emailDigest).toBe(true);
    }
    // The real one opens as Sam's, and only Sam's.
    expect(await unsubscribeUser(t.deps.vault, real)).toBe(sam.userId);
  });
});

describe("the email's parts", () => {
  test("the subject is canvas-first, and names the plan for billing", async () => {
    const line = (text: string) => ({ text, href: null });
    const subject = async (groups: Parameters<typeof digestEmail>[0]) =>
      (await digestEmail(groups, { unsubscribeUrl: "https://api.test/u" })).subject;
    const canvas = (name: string, n: number) => ({
      name,
      lines: Array.from({ length: n }, () => line("Ponzu finished what you asked.")),
      more: 0,
      billing: false,
    });
    expect(await subject([canvas("Fernwood", 1)])).toBe("Fernwood: Ponzu finished what you asked");
    expect(await subject([canvas("Fernwood", 3), canvas("Kettle", 2)])).toBe(
      "Fernwood and Kettle: 5 things since yesterday",
    );
    expect(
      await subject([
        {
          name: "Northbrook",
          lines: [line("You've used 80% of this month's $100 cap.")],
          more: 0,
          billing: true,
        },
      ]),
    ).toBe("You've used 80% of this month's $100 cap");
  });

  test("a link carries the canvas and what to open, and nothing else", () => {
    expect(digestHref({ canvasId: "cnv_1", link: { open: "pull-request" } })).toBe(
      "https://ponzu.design/canvases/cnv_1?open=pull-request",
    );
    expect(digestHref({ canvasId: null, link: { open: "usage" } })).toBeNull();
  });

  test("names are escaped in the HTML, and past ten lines a group counts the rest", async () => {
    const email = await digestEmail(
      [
        {
          name: `<script>alert("x")</script>`,
          lines: Array.from({ length: 10 }, () => ({
            text: "Ponzu replied to your comment.",
            href: null,
          })),
          more: 2,
          billing: false,
        },
      ],
      { unsubscribeUrl: "https://api.test/v1/email/unsubscribe?t=a&b" },
    );
    expect(email.subject).toBe(`<script>alert("x")</script>: 12 things since yesterday`);
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(email.html).toContain("t=a&amp;b");
    expect(email.text).toContain("\nAnd 2 more.\n");
  });
});
