import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  claimEmailNotice,
  emailNotices,
  finishEmailNotice,
  upsertMembership,
  upsertUser,
  upsertWorkspace,
} from "@ponzu/db";
import { SUSPENSION_REASON_MAX } from "@ponzu/email";
import { FakeClock, FakeSandboxes } from "@ponzu/sandbox";
import { MailError, type MailMessage } from "../deps/mail.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { type EmailConfig, parseEmailAllow } from "./kinds.ts";
import {
  NOTICE_CASE,
  NOTICE_PENDING_MAX_MS,
  type NoticeRequest,
  noticeKey,
  planNotice,
  sendNotice,
  sendRefusal,
} from "./notice.ts";
import { type NoticeArgs, type NoticeIo, parseNoticeArgs, runNotice } from "./notice-cli.ts";
import { defineNotice, type NoticeDay, type NoticeFile } from "./notices/define.ts";
import { NOTICES } from "./notices/index.ts";

/*
 * Legal notices (docs/cloud.md, "Email"): the founder's script sends each person a notice at
 * most once, records it, keeps to 5 a second and to the terms' 30 days, and with email off sends
 * and writes nothing. On PGlite, FakeMail and a FakeClock that starts at 2026-01-01.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 1);

const opened: TestApp[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
});

async function app({
  mail = true,
  environment = "production",
  email = {},
}: {
  mail?: boolean;
  environment?: "production" | "dev";
  email?: Partial<EmailConfig>;
} = {}) {
  const clock = new FakeClock(START);
  const t = await createTestApp({
    mail,
    environment,
    email: { replyTo: "hello@ponzu.design", ...email },
    shared: { clock, sandboxes: new FakeSandboxes(clock) },
  });
  opened.push(t);
  return t;
}

let nextGithubId = 610_000;
async function person(t: TestApp, login: string, email: string | null = `${login}@example.com`) {
  const githubUserId = nextGithubId++;
  const user = await upsertUser(t.db, {
    workosUserId: `user_${githubUserId}`,
    githubUserId,
    githubLogin: login,
    name: login,
    email,
    avatarUrl: null,
  });
  // "" for someone without an address, so a list of addresses stays a list of strings.
  return { id: user.id, githubUserId, login, address: email ?? "" };
}

async function workspace(
  t: TestApp,
  kind: "org" | "personal",
  login: string,
  githubAccountId = nextGithubId++,
) {
  return upsertWorkspace(t.db, {
    githubAccountId,
    githubLogin: login,
    kind,
    name: login,
    avatarUrl: null,
    installationId: githubAccountId,
    repositorySelection: "all",
    installedByUserId: null,
  });
}

/** A terms change taking effect `days` after the clock's start. */
function termsChange(days: number): NoticeFile {
  return defineNotice({
    id: "t-terms",
    kind: "terms_change",
    effective: new Date(START + days * DAY).toISOString().slice(0, 10) as NoticeDay,
    summary: ["The terms now say how long a canvas is kept."],
  });
}

const request = (notice: NoticeFile, more: Partial<NoticeRequest> = {}): NoticeRequest => ({
  notice,
  users: null,
  ...more,
});

async function records(t: TestApp) {
  return (await t.db.select().from(emailNotices)).sort((a, b) => a.userId.localeCompare(b.userId));
}

/** Nothing the script prints, logs or captures may be an address. */
function expectNoAddress(t: TestApp, printed: string[], addresses: (string | null)[]) {
  const said = JSON.stringify([printed, t.logs, t.analytics.events, t.analytics.exceptions]);
  for (const address of addresses) if (address) expect(said).not.toContain(address);
}

function io(files: Record<string, string> = {}) {
  const printed: string[] = [];
  const written = new Map<string, string>();
  const value: NoticeIo = {
    readFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    writeFile: async (path, text) => {
      written.set(path, text);
    },
    print: (line) => printed.push(line),
    tmpdir: "/tmp/notices",
  };
  return { io: value, printed, written };
}

function args(argv: string[]): NoticeArgs {
  const parsed = parseNoticeArgs(argv);
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}

describe("with email off (no RESEND_API_KEY)", () => {
  test("--send refuses, and nothing is sent or written", async () => {
    const t = await app({ mail: false });
    await person(t, "off-a");
    const run = io();
    expect(await runNotice(t.deps, args(["--notice", "dev-check", "--send"]), run.io)).toBe(2);
    expect(run.printed.join("\n")).toContain("RESEND_API_KEY is not set");
    expect(t.mail.sent).toEqual([]);
    expect(await records(t)).toEqual([]);
    await expect(sendNotice(t.deps, request(termsChange(60)))).rejects.toThrow(
      "RESEND_API_KEY is not set",
    );
    expect(await records(t)).toEqual([]);
    expect(t.logs.filter((line) => line.event.startsWith("email_"))).toEqual([]);
  });

  test("--dry-run still reads and counts, and writes nothing", async () => {
    const t = await app({ mail: false, environment: "dev" });
    const a = await person(t, "off-b");
    const run = io();
    expect(await runNotice(t.deps, args(["--notice", "dev-check", "--dry-run"]), run.io)).toBe(0);
    expect(run.printed).toContain("Dry run: nothing sent or written.");
    expect(run.printed.join("\n")).toContain("--send would be refused now: RESEND_API_KEY");
    expect(await records(t)).toEqual([]);
    expectNoAddress(t, run.printed, [a.address]);
  });
});

describe("--dry-run", () => {
  test("prints counts and ids, never an address, and renders the email to a file", async () => {
    const t = await app();
    const a = await person(t, "dry-a");
    const b = await person(t, "dry-b");
    const none = await person(t, "dry-none", null);
    // b already has theirs.
    await claimEmailNotice(t.db, {
      noticeId: "dev-check",
      userId: b.id,
      workspaceId: null,
      now: new Date(START),
    });
    await finishEmailNotice(t.db, {
      noticeId: "dev-check",
      userId: b.id,
      outcome: "sent",
      address: b.address,
      resendId: "eml_earlier",
      sentAt: new Date(START),
    });
    const before = await records(t);
    const run = io();
    const code = await runNotice(
      t.deps,
      args(["--notice", "dev-check", "--dry-run", "--out", "/tmp/out"]),
      run.io,
    );
    expect(code).toBe(0);
    expect(t.mail.sent).toEqual([]);
    expect(await records(t)).toEqual(before);
    const text = run.printed.join("\n");
    expect(text).toContain("Notice dev-check: 3 people.");
    expect(text).toContain("without an address now: 1");
    expect(text).toContain("already sent: 1;");
    expect(text).toContain("to send: 2;");
    // dev's check on production: the dry run says --send would refuse it.
    expect(text).toContain("dev-check is a check for dev only");
    expectNoAddress(t, run.printed, [a.address, b.address, none.address]);
    const html = run.written.get("/tmp/out/ponzu-notice-dev-check.html");
    expect(html).toContain("This is a check of how Ponzu sends legal notices");
    expect(run.written.get("/tmp/out/ponzu-notice-dev-check.txt")).toStartWith(
      "Subject: Ponzu's terms change on January 1",
    );
  });

  test("a notice with no day yet is counted but has no sample, and --send refuses it", async () => {
    const t = await app();
    await person(t, "dry-c");
    const run = io();
    expect(await runNotice(t.deps, args(["--notice", "billing-starts", "--dry-run"]), run.io)).toBe(
      0,
    );
    expect(run.printed).toContain("No sample: it has no day it takes effect yet.");
    expect(run.written.size).toBe(0);
    const send = io();
    expect(await runNotice(t.deps, args(["--notice", "billing-starts", "--send"]), send.io)).toBe(
      2,
    );
    expect(send.printed.join("\n")).toContain("has no day it takes effect yet");
    expect(await records(t)).toEqual([]);
  });
});

describe("--send", () => {
  test("sends each person once, however often it is run, and records each", async () => {
    const t = await app();
    const a = await person(t, "send-a");
    const b = await person(t, "send-b");
    const none = await person(t, "send-none", null);
    const notice = termsChange(31);

    const first = await sendNotice(t.deps, request(notice));
    expect(first.outcomes).toEqual({ sent: 2, refused: 0, no_address: 1, held: 0 });
    const second = await sendNotice(t.deps, request(notice));
    expect(second.outcomes).toEqual({ sent: 0, refused: 0, no_address: 0, held: 0 });
    expect(second.alreadyDone).toBe(3);

    expect(t.mail.sent.map((m) => m.to).sort()).toEqual([a.address, b.address].sort());
    const byUser = new Map((await records(t)).map((row) => [row.userId, row]));
    expect(byUser.get(a.id)).toMatchObject({
      noticeId: "t-terms",
      outcome: "sent",
      address: a.address,
      resendId: expect.stringMatching(/^eml_/),
      sentAt: expect.any(Date),
      workspaceId: null,
    });
    expect(byUser.get(none.id)).toMatchObject({
      outcome: "no_address",
      address: null,
      sentAt: null,
    });
    expectNoAddress(t, [], [a.address, b.address]);
  });

  test("each email is the notice, keyed by notice and person, with no unsubscribe", async () => {
    const t = await app();
    const a = await person(t, "mail-a");
    await sendNotice(t.deps, request(termsChange(40)));
    const [message] = t.mail.sent as [MailMessage];
    expect(message.idempotencyKey).toBe(noticeKey("t-terms", a.id));
    expect(message.idempotencyKey).toBe(`notice/t-terms/${a.id}`);
    expect(message.subject).toBe("Ponzu's terms change on February 10");
    expect(message.headers).toEqual({});
    expect(message.replyTo).toBe("hello@ponzu.design");
    expect(message.tags).toEqual([
      { name: "kind", value: "notice" },
      { name: "env", value: "production" },
    ]);
    expect(message.text).toContain("You get this because Ponzu's terms promise it by email.");
  });

  test("a notice is never paused", async () => {
    const t = await app({ email: { paused: new Set(["digest", "billing", "team", "recap"]) } });
    await person(t, "paused-a");
    expect((await sendNotice(t.deps, request(termsChange(40)))).outcomes.sent).toBe(1);
  });

  test("an answer lost after Resend took it is sent again under the same key: one email", async () => {
    const t = await app();
    const a = await person(t, "lost-a");
    const b = await person(t, "lost-b");
    const real = t.mail.send.bind(t.mail);
    let lose = true;
    t.deps.mail = {
      enabled: true,
      send: async (message) => {
        const answer = await real(message);
        if (lose) {
          lose = false;
          throw new MailError("unavailable");
        }
        return answer;
      },
    };
    const first = await sendNotice(t.deps, request(termsChange(40)));
    expect(first.stoppedEarly).toContain("Resend asked to wait");
    // It stopped at the first person: their row is pending, the next has none yet.
    const [lostFirst] = [a, b].sort((x, y) => x.id.localeCompare(y.id));
    expect((await records(t)).map((r) => [r.userId, r.outcome])).toEqual([
      [lostFirst!.id, "pending"],
    ]);

    t.clock.advance(HOUR);
    const second = await sendNotice(t.deps, request(termsChange(40)));
    expect(second.outcomes.sent).toBe(2);
    expect(t.mail.sent).toHaveLength(2);
    expect((await records(t)).find((r) => r.userId === lostFirst!.id)).toMatchObject({
      outcome: "sent",
      resendId: "eml_1",
    });
  });

  test("a crash between the send and its record, then a rerun within a day: one email", async () => {
    const t = await app();
    const a = await person(t, "crash-a");
    const notice = termsChange(40);
    // The process dies just after Resend took the email, before the outcome is written.
    const log = t.deps.log;
    t.deps.log = {
      ...log,
      info: (event, fields) => {
        if (event === "email_sent") throw new Error("the process died");
        log.info(event, fields);
      },
    };
    await expect(sendNotice(t.deps, request(notice))).rejects.toThrow("the process died");
    expect(t.mail.sent).toHaveLength(1);
    expect((await records(t)).map((r) => r.outcome)).toEqual(["pending"]);

    t.deps.log = log;
    t.clock.advance(23 * HOUR);
    const rerun = await sendNotice(t.deps, request(notice));
    expect(rerun.outcomes.sent).toBe(1);
    // FakeMail, as Resend does, answered the same key and bytes with the first email's id.
    expect(t.mail.sent).toHaveLength(1);
    expect(await records(t)).toMatchObject([{ userId: a.id, outcome: "sent", resendId: "eml_1" }]);
  });

  test("a pending row over a day old is listed and never sent again", async () => {
    const t = await app();
    const a = await person(t, "stale-a");
    const b = await person(t, "stale-b");
    const notice = termsChange(40);
    await claimEmailNotice(t.db, {
      noticeId: notice.id,
      userId: a.id,
      workspaceId: null,
      now: new Date(t.clock.now()),
    });
    t.clock.advance(NOTICE_PENDING_MAX_MS);
    const plan = await planNotice(t.deps, request(notice));
    expect(plan.stale).toEqual([a.id]);
    expect(plan.fresh).toBe(1);

    const report = await sendNotice(t.deps, request(notice));
    expect(report.stale).toEqual([a.id]);
    expect(report.outcomes.sent).toBe(1);
    expect(t.mail.sent.map((m) => m.to)).toEqual([b.address]);
    expect((await records(t)).find((r) => r.userId === a.id)?.outcome).toBe("pending");
  });

  test("asks Resend at most 5 times a second", async () => {
    const t = await app();
    for (let i = 0; i < 12; i++) await person(t, `rate-${i}`);
    await person(t, "rate-none", null);
    const at: number[] = [];
    const real = t.mail.send.bind(t.mail);
    t.deps.mail = {
      enabled: true,
      send: async (message) => {
        at.push(t.clock.now());
        return real(message);
      },
    };
    await sendNotice(t.deps, request(termsChange(40)));
    expect(at).toHaveLength(12);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(200);
    for (const start of at) {
      expect(at.filter((x) => x >= start && x < start + 1000).length).toBeLessThanOrEqual(5);
    }
    // And no slower than it must be.
    expect(at.at(-1)! - at[0]!).toBe(11 * 200);
  });

  test("outside production, only the allowlist is emailed; the rest are recorded held", async () => {
    const t = await app({
      environment: "dev",
      email: { allow: parseEmailAllow("dev-a@example.com") },
    });
    const a = await person(t, "dev-a");
    const b = await person(t, "dev-b");
    const report = await sendNotice(t.deps, request(NOTICES.get("dev-check")!));
    expect(report.outcomes).toEqual({ sent: 1, refused: 0, no_address: 0, held: 1 });
    expect(t.mail.sent.map((m) => [m.to, m.subject])).toEqual([
      [a.address, "[Dev] Ponzu's terms change on January 1"],
    ]);
    expect((await records(t)).find((r) => r.userId === b.id)?.outcome).toBe("held");
  });

  test("a refusal from Resend is recorded refused and not sent again", async () => {
    const t = await app();
    await person(t, "refused-a");
    t.mail.failNext("rejected");
    const first = await sendNotice(t.deps, request(termsChange(40)));
    expect(first.outcomes.refused).toBe(1);
    const second = await sendNotice(t.deps, request(termsChange(40)));
    expect(second.alreadyDone).toBe(1);
    expect(t.mail.sent).toEqual([]);
  });

  test("the script exits 1 when a notice needs a look, and names it by id", async () => {
    const t = await app({ environment: "dev", email: { allow: parseEmailAllow("@example.com") } });
    const a = await person(t, "look-a");
    await claimEmailNotice(t.db, {
      noticeId: "dev-check",
      userId: a.id,
      workspaceId: null,
      now: new Date(t.clock.now()),
    });
    t.clock.advance(2 * DAY);
    const run = io();
    expect(await runNotice(t.deps, args(["--notice", "dev-check", "--send"]), run.io)).toBe(1);
    expect(run.printed.join("\n")).toContain(
      `never sent again (look up each person's address in Resend's emails): ${a.id}`,
    );
    expect(t.mail.sent).toEqual([]);
  });
});

describe("who a notice is for", () => {
  test("billing notices: organisation admins and the person of a personal workspace", async () => {
    const t = await app();
    const admin = await person(t, "who-admin");
    const member = await person(t, "who-member");
    const owner = await person(t, "who-owner");
    const guest = await person(t, "who-guest");
    const org = await workspace(t, "org", "who-org");
    await upsertMembership(t.db, { workspaceId: org.id, userId: admin.id, role: "admin" });
    await upsertMembership(t.db, { workspaceId: org.id, userId: member.id, role: "member" });
    const mine = await workspace(t, "personal", owner.login, owner.githubUserId);
    await upsertMembership(t.db, { workspaceId: mine.id, userId: owner.id, role: "admin" });
    // A collaborator on someone's personal workspace, even an admin, is not told.
    await upsertMembership(t.db, { workspaceId: mine.id, userId: guest.id, role: "admin" });

    const notice = defineNotice({ id: "t-bill", kind: "billing_starts", effective: "2026-03-01" });
    const report = await sendNotice(t.deps, request(notice));
    expect(report.outcomes.sent).toBe(2);
    expect(t.mail.sent.map((m) => m.to).sort()).toEqual([admin.address, owner.address].sort());
    const [message] = t.mail.sent as [MailMessage];
    expect(message.subject).toBe("Billing on Ponzu starts on March 1");
    expect(message.text).toContain("100 free credits for each member");
    expect(message.text).toContain("$0.10");
    expect(message.text).toContain("$100");
  });

  test("--user narrows, and naming someone it is not for refuses before anything is written", async () => {
    const t = await app();
    const admin = await person(t, "narrow-admin");
    const loner = await person(t, "narrow-loner");
    const org = await workspace(t, "org", "narrow-org");
    await upsertMembership(t.db, { workspaceId: org.id, userId: admin.id, role: "admin" });
    const notice = defineNotice({ id: "t-bill2", kind: "billing_starts", effective: "2026-03-01" });
    await expect(sendNotice(t.deps, request(notice, { users: [loner.id] }))).rejects.toThrow(
      "not ones it is for",
    );
    expect(await records(t)).toEqual([]);
    expect((await sendNotice(t.deps, request(notice, { users: [admin.id] }))).outcomes.sent).toBe(
      1,
    );

    const dev = await app({
      environment: "dev",
      email: { allow: parseEmailAllow("@example.com") },
    });
    const run = io();
    expect(
      await runNotice(
        dev.deps,
        args(["--notice", "dev-check", "--send", "--user", "usr_nobody"]),
        run.io,
      ),
    ).toBe(2);
    expect(run.printed.join("\n")).toContain("usr_nobody");
    expect(await records(dev)).toEqual([]);
    expect(dev.mail.sent).toEqual([]);
  });
});

describe("the 30 days", () => {
  const on = {
    now: new Date(START),
    environment: "production",
    mailEnabled: true,
    allowlisted: false,
  };

  test("a dated notice less than 30 days off is refused; 30 days is allowed", () => {
    expect(sendRefusal(request(termsChange(29)), on)).toContain("less than 30 days");
    expect(sendRefusal(request(termsChange(30)), on)).toBeNull();
    const shutdown = defineNotice({
      id: "t-close",
      kind: "shutdown",
      effective: "2026-01-20",
      summary: [],
    });
    expect(sendRefusal(request(shutdown), on)).toContain("less than 30 days");
  });

  test("only a terms change may go sooner, with --sooner", () => {
    expect(sendRefusal(request(termsChange(3), { sooner: true }), on)).toBeNull();
    const privacy = defineNotice({
      id: "t-privacy",
      kind: "privacy_change",
      effective: "2026-01-05",
      summary: ["A new use."],
    });
    expect(sendRefusal(request(privacy, { sooner: true }), on)).toContain("terms change only");
  });

  test("the script refuses a too-soon notice before writing anything", async () => {
    const t = await app();
    await person(t, "soon-a");
    await expect(sendNotice(t.deps, request(termsChange(10)))).rejects.toThrow("less than 30 days");
    expect(await records(t)).toEqual([]);
    expect(t.mail.sent).toEqual([]);
  });

  test("dev's check is refused on production", () => {
    const check = request(NOTICES.get("dev-check")!);
    expect(sendRefusal(check, on)).toContain("dev only");
    expect(sendRefusal(check, { ...on, environment: "dev", allowlisted: true })).toBeNull();
  });

  test("off production, --send without an allowlist is refused before anything is written", async () => {
    // Everyone would be recorded held for good: a PONZU_ENVIRONMENT mistyped against
    // production's database would close the notice to all of them.
    const t = await app({ environment: "dev" });
    await person(t, "noallow-a");
    const run = io();
    expect(await runNotice(t.deps, args(["--notice", "dev-check", "--send"]), run.io)).toBe(2);
    expect(run.printed.join("\n")).toContain("PONZU_EMAIL_ALLOW is not set");
    expect(await records(t)).toEqual([]);
    expect(t.mail.sent).toEqual([]);
    expect(sendRefusal(request(termsChange(60)), on)).toBeNull();
  });

  test("an empty PONZU_EMAIL_ALLOW counts as no allowlist", async () => {
    const t = await app({ environment: "dev", email: { allow: parseEmailAllow("") } });
    await person(t, "emptyallow-a");
    const run = io();
    expect(await runNotice(t.deps, args(["--notice", "dev-check", "--send"]), run.io)).toBe(2);
    expect(run.printed.join("\n")).toContain("PONZU_EMAIL_ALLOW is not set");
    expect(await records(t)).toEqual([]);
    expect(t.mail.sent).toEqual([]);
  });
});

describe("a suspension", () => {
  test("goes to the people named, with the reason escaped, recorded under its case", async () => {
    const t = await app();
    const a = await person(t, "sus-a");
    await person(t, "sus-bystander");
    const ws = await workspace(t, "org", "sus-org");
    await upsertMembership(t.db, { workspaceId: ws.id, userId: a.id, role: "member" });
    const reason = 'Payments were reported as <script>alert("x")</script> fraud & more.';
    const run = io({ "/reason.txt": `${reason}\n` });
    const code = await runNotice(
      t.deps,
      args([
        "--notice",
        "suspension",
        "--send",
        "--case",
        "2026-01-fraud",
        "--user",
        a.id,
        "--workspace",
        ws.id,
        "--reason-file",
        "/reason.txt",
      ]),
      run.io,
    );
    expect(code).toBe(0);
    expect(run.printed.join("\n")).not.toContain("script");
    expect(t.mail.sent).toHaveLength(1);
    const [message] = t.mail.sent as [MailMessage];
    expect(message.to).toBe(a.address!);
    expect(message.subject).toBe("sus-org is suspended on Ponzu");
    expect(message.idempotencyKey).toBe(`notice/suspension/2026-01-fraud/${a.id}`);
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.text).toContain(reason);
    expect(await records(t)).toMatchObject([
      { noticeId: "suspension/2026-01-fraud", userId: a.id, workspaceId: ws.id, outcome: "sent" },
    ]);
  });

  test("a workspace's suspension tells only its members, and an unknown workspace is refused", async () => {
    const t = await app();
    const member = await person(t, "sus-member");
    const stranger = await person(t, "sus-stranger");
    const ws = await workspace(t, "org", "sus-private-org");
    await upsertMembership(t.db, { workspaceId: ws.id, userId: member.id, role: "member" });
    const base = ["--notice", "suspension", "--send", "--case", "c2", "--reason-file", "/r.txt"];
    const files = { "/r.txt": "Abuse." };

    const strangers = io(files);
    const withStranger = [...base, "--workspace", ws.id, "--user", member.id];
    expect(
      await runNotice(t.deps, args([...withStranger, "--user", stranger.id]), strangers.io),
    ).toBe(2);
    expect(strangers.printed.join("\n")).toContain(stranger.id);
    for (const dry of [true, false]) {
      const unknown = io(files);
      const argv = [...base, "--workspace", "ws_nope", "--user", member.id];
      const flags = dry ? argv.map((flag) => (flag === "--send" ? "--dry-run" : flag)) : argv;
      expect(await runNotice(t.deps, args(flags), unknown.io)).toBe(2);
      expect(unknown.printed.join("\n")).toContain("no workspace ws_nope");
    }
    expect(await records(t)).toEqual([]);
    expect(t.mail.sent).toEqual([]);

    expect(await runNotice(t.deps, args(withStranger), io(files).io)).toBe(0);
    expect(t.mail.sent.map((m) => m.to)).toEqual([member.address]);
  });

  test("refuses a reason over 1,000 characters, no case, or no one named, before anything", async () => {
    const t = await app();
    const a = await person(t, "sus-long");
    const long = io({ "/long.txt": "x".repeat(SUSPENSION_REASON_MAX + 1) });
    const base = ["--notice", "suspension", "--send", "--user", a.id];
    expect(
      await runNotice(
        t.deps,
        args([...base, "--case", "c1", "--reason-file", "/long.txt"]),
        long.io,
      ),
    ).toBe(2);
    expect(long.printed.join("\n")).toContain("at most 1000 characters");
    const fine = { "/ok.txt": "x".repeat(SUSPENSION_REASON_MAX) };
    const noCase = io(fine);
    expect(await runNotice(t.deps, args([...base, "--reason-file", "/ok.txt"]), noCase.io)).toBe(2);
    const nobody = io(fine);
    expect(
      await runNotice(
        t.deps,
        args(["--notice", "suspension", "--send", "--case", "c1", "--reason-file", "/ok.txt"]),
        nobody.io,
      ),
    ).toBe(2);
    expect(await records(t)).toEqual([]);
    expect(t.mail.sent).toEqual([]);

    const ok = io(fine);
    expect(
      await runNotice(t.deps, args([...base, "--case", "c1", "--reason-file", "/ok.txt"]), ok.io),
    ).toBe(0);
    expect(t.mail.sent).toHaveLength(1);
  });

  test("other notices take no reason, case or workspace", async () => {
    const t = await app();
    const run = io({ "/r.txt": "why" });
    expect(
      await runNotice(
        t.deps,
        args(["--notice", "dev-check", "--dry-run", "--reason-file", "/r.txt"]),
        run.io,
      ),
    ).toBe(2);
    expect(run.printed.join("\n")).toContain("for a suspension only");
  });
});

describe("the notice files", () => {
  test("each is listed once, under its file's name", () => {
    const files = readdirSync(join(import.meta.dir, "notices"))
      .filter((name) => name.endsWith(".ts") && !["index.ts", "define.ts"].includes(name))
      .map((name) => name.slice(0, -3))
      .sort();
    expect([...NOTICES.keys()].sort()).toEqual(files);
    for (const [id, notice] of NOTICES) {
      expect(notice.id).toBe(id);
      expect(id).toMatch(NOTICE_CASE);
      if (notice.kind !== "suspension" && notice.effective !== null) {
        expect(new Date(`${notice.effective}T00:00:00Z`).toISOString().slice(0, 10)).toBe(
          notice.effective,
        );
      }
    }
  });

  test("billing starts waits for the founder's day", () => {
    expect(NOTICES.get("billing-starts")).toMatchObject({
      kind: "billing_starts",
      effective: null,
    });
  });
});

describe("the arguments", () => {
  test("need a notice and exactly one of --dry-run and --send", () => {
    expect(parseNoticeArgs([])).toBe("Say which notice with --notice <id>.");
    expect(parseNoticeArgs(["--notice", "x"])).toContain("exactly one");
    expect(parseNoticeArgs(["--notice", "x", "--dry-run", "--send"])).toContain("exactly one");
    expect(parseNoticeArgs(["--notice", "x", "--send", "--user"])).toBe("--user needs a value.");
    expect(parseNoticeArgs(["--notice", "x", "--send", "--bogus"])).toBe(
      "Not understood: --bogus.",
    );
    expect(
      parseNoticeArgs(["--notice", "x", "--send", "--user", "a", "--user", "b", "--sooner"]),
    ).toMatchObject({ noticeId: "x", send: true, users: ["a", "b"], sooner: true });
  });

  test("an unknown notice is refused", async () => {
    const t = await app();
    const run = io();
    expect(await runNotice(t.deps, args(["--notice", "nope", "--send"]), run.io)).toBe(2);
    expect(run.printed[0]).toContain("No notice nope.");
  });
});
