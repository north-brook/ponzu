import { afterEach, describe, expect, test } from "bun:test";
import {
  digestRecipient,
  enqueueJob,
  insertNotifications,
  listRecentForDigest,
  stampNotificationEmailed,
} from "@ponzu/db";
import type { RenderedEmail } from "@ponzu/email";
import { RetryLater } from "../jobs/retry.ts";
import { enqueueDigests, runDigestJob } from "../notifications/digest.ts";
import { workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, TEST_API_URL, type TestApp } from "../testing/index.ts";
import { type EmailKind, parseEmailAllow } from "./kinds.ts";
import { canvasHref } from "./links.ts";
import { DEV_SUBJECT_PREFIX, IDEMPOTENCY_KEY_MAX, type SendOutcome, sendEmail } from "./send.ts";
import { openUnsubscribeToken } from "./unsubscribe.ts";

/*
 * The one door every email goes out of (email/send.ts), on the real app with a fake Resend
 * (FakeMail): each of its answers, in its order, and what it writes and logs for each.
 */

const opened: TestApp[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
});

async function app(options: Parameters<typeof createTestApp>[0] = {}) {
  const t = await createTestApp({ mail: true, environment: "production", ...options });
  opened.push(t);
  return t;
}

const SUBJECT = "Kettle onboarding: Ponzu has a question for you";
const BODY = "Ponzu has a question for you, about something private.";

/** A fixed email, as a template would render it, with its unsubscribe link in it. */
function render(parts: { unsubscribeUrl: string | null }, extra = ""): RenderedEmail {
  const stop = parts.unsubscribeUrl ? ` Stop: ${parts.unsubscribeUrl}` : "";
  return {
    subject: SUBJECT,
    preview: BODY,
    html: `<p>${BODY}${extra}${stop}</p>`,
    text: `${BODY}${extra}${stop}\n`,
  };
}

/** Set columns of a person's row directly, as SQL (`email = null`). */
async function setUser(t: TestApp, userId: string, set: string) {
  await t.db.execute(`update users set ${set} where id = '${userId}'`);
}

let logins = 0;
async function personIn(t: TestApp) {
  const login = `maya${++logins}`;
  const person = await t.signInAs({ login });
  return { ...person, address: `${login}@example.com` };
}

const send = (t: TestApp, kind: EmailKind, userId: string, key = `${kind}:${userId}:1`) =>
  sendEmail(t.deps, { kind, userId, key, render: (parts) => render(parts) });

/** Nothing the logs or events hold may be an address, a subject or a body. */
function expectNothingPrivate(t: TestApp, address: string) {
  const said = JSON.stringify([t.logs, t.analytics.events, t.analytics.exceptions]);
  expect(said).not.toContain(address);
  expect(said).not.toContain("Kettle onboarding");
  expect(said).not.toContain("something private");
}

describe("sendEmail answers, in order", () => {
  test("off without RESEND_API_KEY: nothing read, written, sent or logged", async () => {
    const t = await app({ mail: false });
    const { userId } = await personIn(t);
    const before = t.logs.length;
    for (const kind of ["digest", "billing", "team", "recap", "notice"] as const) {
      expect(await send(t, kind, userId)).toBe("off");
    }
    expect(t.mail.sent).toEqual([]);
    expect(t.logs.slice(before)).toEqual([]);
    expect(t.analytics.events.filter((e) => e.event.startsWith("email "))).toEqual([]);
  });

  test("a paused kind is dropped before anything is read; a legal notice is never paused", async () => {
    const t = await app({ email: { paused: new Set(["billing", "team", "recap", "digest"]) } });
    const { userId, address } = await personIn(t);
    for (const kind of ["digest", "billing", "team", "recap"] as const) {
      expect(await send(t, kind, userId)).toBe("paused");
    }
    expect(t.mail.sent).toEqual([]);
    expect(t.logs.filter((l) => l.event === "email_paused").map((l) => l.kind)).toEqual([
      "digest",
      "billing",
      "team",
      "recap",
    ]);
    expect(await send(t, "notice", userId)).toBe("sent");
    expect(t.mail.sent.map((m) => m.to)).toEqual([address]);
  });

  test("no address, or no person any more: no_address", async () => {
    const t = await app();
    const { userId } = await personIn(t);
    await setUser(t, userId, "email = null");
    expect(await send(t, "billing", userId)).toBe("no_address");
    expect(await send(t, "billing", "usr_gone")).toBe("no_address");
    expect(t.mail.sent).toEqual([]);
  });

  test("a switch that is off is opted_out; billing and notices have none to turn off", async () => {
    const t = await app();
    const { userId } = await personIn(t);
    // The digest is off by default; people joined and the recap are on.
    expect(await send(t, "digest", userId)).toBe("opted_out");
    expect(await send(t, "team", userId)).toBe("sent");
    expect(await send(t, "recap", userId)).toBe("sent");
    await setUser(t, userId, "email_digest = false, email_team = false, email_recap = false");
    const outcomes: Record<string, SendOutcome> = {};
    for (const kind of ["digest", "team", "recap", "billing", "notice"] as const) {
      outcomes[kind] = await send(t, kind, userId, `${kind}:${userId}:2`);
    }
    expect(outcomes).toEqual({
      digest: "opted_out",
      team: "opted_out",
      recap: "opted_out",
      billing: "sent",
      notice: "sent",
    });
  });

  test("outside production with no allowlist everything is held, and Resend is never asked", async () => {
    for (const environment of ["dev", "preview", "local"] as const) {
      const t = await app({ environment });
      const { userId } = await personIn(t);
      for (const kind of ["billing", "team", "recap", "notice"] as const) {
        expect(await send(t, kind, userId)).toBe("held");
      }
      expect(t.mail.sent).toEqual([]);
      expect(t.logs.filter((l) => l.event === "email_held")).toHaveLength(4);
    }
  });

  test("outside production only the allowlist is emailed, marked [Dev], with dev's links", async () => {
    const allow = parseEmailAllow("someone@else.com, @northbrook.dev")!;
    const t = await app({ environment: "dev", email: { allow } });
    const stranger = await personIn(t);
    expect(await send(t, "billing", stranger.userId)).toBe("held");
    const domain = await t.signInAs({ login: "ines", email: "Ines@Northbrook.dev" });
    const link = canvasHref(t.deps.config.build.environment, "cnv_1", { open: "thread" });
    expect(
      await sendEmail(t.deps, {
        kind: "billing",
        userId: domain.userId,
        key: "billing:dev",
        render: (parts) => render(parts, ` ${link}`),
      }),
    ).toBe("sent");
    const [email] = t.mail.sent;
    expect(email!.to).toBe("Ines@Northbrook.dev");
    expect(email!.subject).toBe(`${DEV_SUBJECT_PREFIX}${SUBJECT}`);
    expect(email!.text).toContain("https://ponzu.design/canvases/cnv_1?open=thread&app=ponzu-dev");
    expect(email!.tags).toEqual([
      { name: "kind", value: "billing" },
      { name: "env", value: "dev" },
    ]);
  });

  test("production ignores the allowlist, set or not", async () => {
    const t = await app({ email: { allow: parseEmailAllow("only@else.com") } });
    const { userId, address } = await personIn(t);
    expect(await send(t, "billing", userId)).toBe("sent");
    const [email] = t.mail.sent;
    expect(email!.to).toBe(address);
    expect(email!.subject).toBe(SUBJECT);
    expect(email!.tags).toEqual([
      { name: "kind", value: "billing" },
      { name: "env", value: "production" },
    ]);
    expect(t.analytics.events.filter((e) => e.event === "email sent")).toMatchObject([
      { distinctId: userId, properties: { kind: "billing" } },
    ]);
    expectNothingPrivate(t, address);
  });

  test("Resend busy or down is tried later with the same key; a refusal is final and reported", async () => {
    const t = await app();
    const { userId, address } = await personIn(t);
    for (const code of ["rate_limited", "unavailable"] as const) {
      t.mail.failNext(code);
      const thrown = await send(t, "billing", userId).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(RetryLater);
      expect((thrown as RetryLater).ms).toBe(5 * 60_000);
    }
    expect(t.mail.sent).toEqual([]);
    // The retry goes, under the same key.
    expect(await send(t, "billing", userId)).toBe("sent");
    expect(t.mail.sent.map((m) => m.idempotencyKey)).toEqual([`billing:${userId}:1`]);

    t.mail.failNext("rejected");
    expect(await send(t, "billing", userId, "billing:other")).toBe("refused");
    expect(t.logs.filter((l) => l.event === "email_refused")).toMatchObject([
      { level: "error", kind: "billing", job: "billing:other", failure: "rejected" },
    ]);
    expect(t.analytics.events.filter((e) => e.event === "email refused")).toMatchObject([
      { distinctId: userId, properties: { kind: "billing", failure: "rejected" } },
    ]);
    expect(t.analytics.exceptions).toHaveLength(1);
    expectNothingPrivate(t, address);
  });

  test("a retry within the day sends nothing more: the same bytes get the first id", async () => {
    const t = await app();
    const { userId } = await personIn(t);
    // A billing email has no token in it: the retry is byte for byte the first.
    expect(await send(t, "billing", userId)).toBe("sent");
    expect(await send(t, "billing", userId)).toBe("sent");
    expect(t.mail.sent).toHaveLength(1);
    // A kind with an unsubscribe link seals a new token each time, so its retry differs in that
    // link alone: Resend answers 409 for the key, which is `duplicate`, counted as sent, once.
    expect(await send(t, "team", userId)).toBe("sent");
    expect(await send(t, "team", userId)).toBe("duplicate");
    expect(t.mail.sent).toHaveLength(2);
    expect(t.logs.filter((l) => l.event === "email_duplicate")).toHaveLength(1);
  });

  test("the unsubscribe header is on exactly the kinds that can be turned off, for that kind", async () => {
    const t = await app({ email: { replyTo: "hello@ponzu.design" } });
    const { userId } = await personIn(t);
    await setUser(t, userId, "email_digest = true");
    for (const kind of ["digest", "team", "recap", "billing", "notice"] as const) {
      expect(await send(t, kind, userId)).toBe("sent");
    }
    const byKind = Object.fromEntries(
      t.mail.sent.map((m) => [m.tags!.find((tag) => tag.name === "kind")!.value, m]),
    );
    for (const kind of ["digest", "team", "recap"] as const) {
      const email = byKind[kind]!;
      expect(Object.keys(email.headers).sort()).toEqual([
        "List-Unsubscribe",
        "List-Unsubscribe-Post",
      ]);
      expect(email.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      const url = new URL(email.headers["List-Unsubscribe"]!.slice(1, -1));
      expect(url.origin + url.pathname).toBe(`${TEST_API_URL}/v1/email/unsubscribe`);
      expect(await openUnsubscribeToken(t.deps.vault, url.searchParams.get("t"))).toEqual({
        userId,
        category: kind,
      });
      // The body's link is the header's.
      expect(email.text).toContain(url.toString());
    }
    for (const kind of ["billing", "notice"] as const) {
      expect(byKind[kind]!.headers).toEqual({});
      expect(byKind[kind]!.text).not.toContain("unsubscribe");
    }
    expect(t.mail.sent.every((m) => m.replyTo === "hello@ponzu.design")).toBe(true);
  });

  test("a key longer than Resend takes is a caller's mistake", async () => {
    const t = await app();
    const { userId } = await personIn(t);
    await expect(send(t, "billing", userId, "k".repeat(IDEMPOTENCY_KEY_MAX + 1))).rejects.toThrow(
      "An email's key is 1 to 256 characters.",
    );
    expect(await send(t, "billing", userId, "k".repeat(IDEMPOTENCY_KEY_MAX))).toBe("sent");
  });
});

describe("the digest on the one door", () => {
  async function digestPerson(t: TestApp) {
    const person = await personIn(t);
    await setUser(t, person.userId, "email_digest = true, time_zone = 'Europe/Lisbon'");
    return person;
  }

  async function billingRow(t: TestApp, userId: string, workspaceId: string | null = null) {
    const [row] = await insertNotifications(t.db, {
      now: new Date(t.clock.now()),
      rows: [
        {
          userId,
          workspaceId,
          canvasId: null,
          kind: "billing_cap_warning",
          dedupeKey: `billing:cap_warning:${userId}`,
          title: "ws",
          body: "Your workspace has used 80% of this month's $100 cap.",
          link: { open: "usage" },
          muted: false,
        },
      ],
    });
    return row!;
  }

  test("paused: nothing is recorded, and a job recorded before stamps the day without sending", async () => {
    const t = await app({ email: { paused: new Set(["digest"]) } });
    // An admin of an organisation, with a billing line to say: the pause, not an empty day, is
    // what stops it.
    const ws = await workspaceWithRepo(t, { [`owner${++logins}`]: "admin" });
    const { userId } = ws.people[`owner${logins}`]!;
    await setUser(t, userId, "email_digest = true, time_zone = 'Europe/Lisbon'");
    await billingRow(t, userId, ws.id);
    t.clock.advance(9 * 60 * 60_000);
    const now = new Date(t.clock.now());
    expect(await enqueueDigests(t.deps, now)).toEqual({ due: 0, recorded: 0 });
    // A job recorded before the pause.
    const job = await enqueueJob(t.db, {
      kind: "email.digest",
      key: `digest:${userId}:2026-01-01`,
      payload: { userId, localDate: "2026-01-01", until: now.toISOString() },
      runAt: now,
    });
    expect(job).not.toBeNull();
    await runDigestJob(t.deps, job!.payload, {
      id: job!.id,
      kind: job!.kind,
      payload: job!.payload,
      attempts: 1,
      maxAttempts: 5,
    });
    expect(t.mail.sent).toEqual([]);
    expect((await digestRecipient(t.db, userId))?.digestSentOn).toBe("2026-01-01");
    expect(t.logs.filter((l) => l.event === "email_paused")).toMatchObject([{ kind: "digest" }]);
    expect(t.logs.filter((l) => l.event === "digest_done")).toMatchObject([
      { outcome: "paused", groups: 1 },
    ]);
  });

  test("a billing row whose email is done with is left out of the digest", async () => {
    const t = await app();
    const { userId } = await digestPerson(t);
    const kept = await billingRow(t, userId);
    const since = new Date(t.clock.now() - 60_000);
    expect((await listRecentForDigest(t.db, { userId, since })).map((r) => r.id)).toEqual([
      kept.id,
    ]);
    expect(
      await stampNotificationEmailed(t.db, {
        notificationId: kept.id,
        now: new Date(t.clock.now()),
      }),
    ).toBe(true);
    // The first stamp stays.
    expect(
      await stampNotificationEmailed(t.db, {
        notificationId: kept.id,
        now: new Date(t.clock.now()),
      }),
    ).toBe(false);
    expect(await listRecentForDigest(t.db, { userId, since })).toEqual([]);
  });
});
