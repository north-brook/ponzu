import {
  digestRecipient,
  digestsDue,
  enqueueJob,
  listRecentForDigest,
  type Notification,
  notifyCanvasFacts,
  notifyWorkspaceFacts,
  stampDigestSent,
} from "@ponzu/db";
import { z } from "zod";
import { MailError, mailErrorOf } from "../deps/mail.ts";
import { RetryLater } from "../jobs/retry.ts";
import type { JobDeps, RunningJob } from "../jobs/run.ts";
import { titleOf } from "./copy.ts";
import { canvasFactsOf } from "./facts.ts";
import { isBillingKind } from "./kinds.ts";
import { billingRecipients, canRead } from "./recipients.ts";
import { unsubscribeToken } from "./unsubscribe.ts";

/*
 * The daily email (docs/cloud.md, "Notifications"): once a day, from 9:00 where the person is,
 * what Ponzu told them about in the last day that they have not read, or that their toggles
 * kept quiet. It is opt-in (Settings › Notifications › Email) and off for everyone until
 * RESEND_API_KEY is set.
 *
 * At minute 0 of each hour the cron's `digests` step records an `email.digest` job for each
 * person whose email is due (`digestsDue`), keyed `digest:<user>:<local date>`. The job reads
 * their notifications, drops what they can no longer read, sends one email through `deps.mail`
 * with the job's key as Resend's idempotency key, and stamps `digest_sent_on`. With nothing to
 * say it only stamps.
 *
 * The email says nothing a ping would not: each canvas's name (or a billing ping's workspace's)
 * and the rows' own sentences, which copy.ts wrote. Never anything a person or the agent wrote
 * besides those names.
 */

export const DIGEST_JOB = "email.digest";

/** How far back the email looks: the day before it was due. */
export const DIGEST_WINDOW_MS = 24 * 60 * 60_000;

/** At most this many lines under one canvas; the rest are counted in a last line. */
export const DIGEST_LINES_PER_GROUP = 10;

/** How long a send that Resend could not take now waits before it is tried again. */
const DIGEST_RETRY_MS = 5 * 60_000;

/** Where a canvas's link lands: the site's page that hands it to the app. */
export const SITE_URL = "https://ponzu.design";

const DigestPayload = z.object({
  userId: z.string().min(1).max(64),
  /** The person's local date it is for, `YYYY-MM-DD`. */
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** When it was found due: the end of the day it covers, the same on every attempt. */
  until: z.iso.datetime(),
});

/** The job's key, and the email's idempotency key. */
export function digestKey(userId: string, localDate: string): string {
  return `digest:${userId}:${localDate}`;
}

/**
 * The cron's hourly step: record a digest job for everyone whose email is due at `now`. Nothing
 * while email is off. One already waiting for the same person and date is left to do it.
 */
export async function enqueueDigests(
  deps: Pick<JobDeps, "db" | "mail">,
  now: Date,
): Promise<{ due: number; recorded: number }> {
  if (!deps.mail.enabled) return { due: 0, recorded: 0 };
  const due = await digestsDue(deps.db, { now });
  let recorded = 0;
  for (const { userId, localDate } of due) {
    const job = await enqueueJob(deps.db, {
      kind: DIGEST_JOB,
      key: digestKey(userId, localDate),
      payload: { userId, localDate, until: now.toISOString() },
      runAt: now,
    });
    if (job) recorded++;
  }
  return { due: due.length, recorded };
}

/** One canvas (or, for billing, one workspace) and its lines. */
export interface DigestGroup {
  /** The canvas's or workspace's name, as a ping's title. */
  name: string;
  lines: { text: string; href: string | null }[];
  /** Lines past `DIGEST_LINES_PER_GROUP`, left out. */
  more: number;
  /** A workspace's billing pings, not a canvas's. */
  billing: boolean;
}

export interface DigestEmail {
  subject: string;
  html: string;
  text: string;
}

/** The link a row opens on the site: its canvas, with what to open there riding along. */
export function digestHref(row: Pick<Notification, "canvasId" | "link">): string | null {
  if (!row.canvasId) return null;
  const url = new URL(`/canvases/${encodeURIComponent(row.canvasId)}`, SITE_URL);
  url.searchParams.set("open", row.link.open);
  if (row.link.pageId) url.searchParams.set("page", row.link.pageId);
  if (row.link.artboardId) url.searchParams.set("artboard", row.link.artboardId);
  if (row.link.questionId) url.searchParams.set("question", row.link.questionId);
  if (row.link.commentThreadId) url.searchParams.set("comment", row.link.commentThreadId);
  return url.toString();
}

/**
 * The person's rows as the email's groups: rows about a canvas they can still read, by canvas,
 * and billing rows for a workspace they still hear billing for, by workspace. A needs-you whose
 * question has closed is left out. Groups come newest first, and their lines oldest first.
 *
 * "Can still read" is judged as a ping is (recipients.ts: a member, with a kept answer of read or
 * more), but with the kept answer's age counted from the group's newest row, not from now. The
 * email is for people who have been away, whose answers are often more than a day old; what
 * counts is that Ponzu has learned nothing since that takes the canvas away. A member who left,
 * or a kept answer that changed to less than read, drops the canvas.
 */
export async function digestGroups(
  deps: Pick<JobDeps, "db">,
  userId: string,
  rows: readonly Notification[],
): Promise<DigestGroup[]> {
  const byPlace = new Map<string, Notification[]>();
  for (const row of rows) {
    if (row.resolvedAt !== null) continue;
    const place = row.canvasId
      ? `canvas:${row.canvasId}`
      : isBillingKind(row.kind) && row.workspaceId
        ? `workspace:${row.workspaceId}`
        : null;
    if (!place) continue;
    const list = byPlace.get(place) ?? [];
    list.push(row);
    byPlace.set(place, list);
  }

  const groups: { group: DigestGroup; newest: number }[] = [];
  for (const [place, list] of byPlace) {
    const [kind, id] = place.split(":") as ["canvas" | "workspace", string];
    let name: string | null = null;
    const newestMade = new Date(Math.max(...list.map((row) => row.createdAt.getTime())));
    if (kind === "canvas") {
      const canvas = await notifyCanvasFacts(deps.db, { canvasId: id });
      if (canvas && canRead(canvasFactsOf(canvas), userId, newestMade)) name = canvas.name;
    } else {
      const workspace = await notifyWorkspaceFacts(deps.db, id);
      if (workspace && billingRecipients(workspace).includes(userId)) name = workspace.name;
    }
    if (name === null) continue;
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const kept = sorted.slice(0, DIGEST_LINES_PER_GROUP);
    groups.push({
      group: {
        name: titleOf(name),
        lines: kept.map((row) => ({ text: row.body, href: digestHref(row) })),
        more: sorted.length - kept.length,
        billing: kind === "workspace",
      },
      newest: Math.max(...sorted.map((row) => row.updatedAt.getTime())),
    });
  }
  return groups.sort((a, b) => b.newest - a.newest).map(({ group }) => group);
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Ponzu: 3 things on 2 canvases", "… and your plan", or "Ponzu: 1 thing on your plan". */
export function digestSubject(things: number, canvases: number, billing: boolean): string {
  const where = [
    ...(canvases > 0 ? [count(canvases, "canvas", "canvases")] : []),
    ...(billing ? ["your plan"] : []),
  ].join(" and ");
  return `Ponzu: ${count(things, "thing", "things")} on ${where}`;
}

const INTRO = "Here is what Ponzu told you about in the last day.";
const FOOTER = "You get this email once a day because it is on in Ponzu's Settings.";
const STOP = "Stop these emails";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const moreLine = (more: number) => `And ${more} more.`;

/** The email itself, from its groups. */
export function digestEmail(
  groups: readonly DigestGroup[],
  { unsubscribeUrl }: { unsubscribeUrl: string },
): DigestEmail {
  const things = groups.reduce((sum, group) => sum + group.lines.length + group.more, 0);
  const canvases = groups.filter((group) => !group.billing).length;
  const subject = digestSubject(
    things,
    canvases,
    groups.some((group) => group.billing),
  );

  const text = [
    INTRO,
    "",
    ...groups.flatMap((group) => [
      group.name,
      ...group.lines.map((line) => `- ${line.text}${line.href ? ` ${line.href}` : ""}`),
      ...(group.more > 0 ? [`- ${moreLine(group.more)}`] : []),
      "",
    ]),
    FOOTER,
    `${STOP}: ${unsubscribeUrl}`,
    "",
  ].join("\n");

  const font =
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    `<body style="margin:0;padding:24px 16px;background:#ffffff;color:#1c1c1c;${font}font-size:15px;line-height:1.5">`,
    '<div style="max-width:560px;margin:0 auto">',
    `<p style="margin:0 0 20px">${escapeHtml(INTRO)}</p>`,
    ...groups.map((group) =>
      [
        `<h2 style="margin:20px 0 6px;font-size:16px;font-weight:600">${escapeHtml(group.name)}</h2>`,
        '<ul style="margin:0;padding-left:20px">',
        ...group.lines.map((line) => {
          const words = escapeHtml(line.text);
          return line.href
            ? `<li><a href="${escapeHtml(line.href)}" style="color:#1c1c1c">${words}</a></li>`
            : `<li>${words}</li>`;
        }),
        ...(group.more > 0 ? [`<li>${escapeHtml(moreLine(group.more))}</li>`] : []),
        "</ul>",
      ].join(""),
    ),
    `<p style="margin:28px 0 0;color:#6b6b6b;font-size:13px">${escapeHtml(FOOTER)} `,
    `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b6b6b">${STOP}</a>.</p>`,
    "</div></body></html>",
  ].join("");

  return { subject, html, text };
}

/** Where the person's unsubscribe link goes: this API's own address. */
export async function unsubscribeUrl(
  deps: Pick<JobDeps, "vault" | "config">,
  userId: string,
): Promise<string> {
  const url = new URL("/v1/email/unsubscribe", deps.config.sandbox.apiUrl);
  url.searchParams.set("t", await unsubscribeToken(deps.vault, userId));
  return url.toString();
}

/** The `email.digest` job: one person's email for one local date. */
export async function runDigestJob(
  deps: JobDeps,
  payload: unknown,
  _job: RunningJob,
): Promise<void> {
  const { db, log } = deps;
  const { userId, localDate, until } = DigestPayload.parse(payload);
  if (!deps.mail.enabled) {
    log.info("digest_skipped", { userId, reason: "mail_off" });
    return;
  }
  const person = await digestRecipient(db, userId);
  if (!person || !person.emailDigest || !person.email) return;
  if (person.digestSentOn !== null && person.digestSentOn >= localDate) return;

  const end = new Date(until);
  const rows = (
    await listRecentForDigest(db, { userId, since: new Date(end.getTime() - DIGEST_WINDOW_MS) })
  ).filter((row) => row.createdAt.getTime() <= end.getTime());
  const groups = await digestGroups(deps, userId, rows);
  if (groups.length === 0) {
    await stampDigestSent(db, { userId, localDate });
    log.info("digest_empty", { userId });
    return;
  }

  const unsubscribe = await unsubscribeUrl(deps, userId);
  const email = digestEmail(groups, { unsubscribeUrl: unsubscribe });
  try {
    await deps.mail.send({
      to: person.email,
      ...email,
      headers: {
        "List-Unsubscribe": `<${unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      idempotencyKey: digestKey(userId, localDate),
    });
  } catch (error) {
    const failure = error instanceof MailError ? error : mailErrorOf(null);
    if (failure.code === "rate_limited" || failure.code === "unavailable") {
      throw new RetryLater(DIGEST_RETRY_MS, `Resend could not take the email: ${failure.code}.`);
    }
    // `duplicate`: this key's email went already. `rejected`: sending it again will not help.
    // Either way, today's is done.
    await stampDigestSent(db, { userId, localDate });
    if (failure.code === "rejected") {
      log.error("digest_failed", { userId, failure: failure.code, status: failure.status });
      deps.analytics.exception(failure, { job: DIGEST_JOB });
    } else {
      log.warn("digest_duplicate", { userId });
    }
    return;
  }
  await stampDigestSent(db, { userId, localDate });
  log.info("digest_sent", {
    userId,
    groups: groups.length,
    lines: groups.reduce((sum, group) => sum + group.lines.length + group.more, 0),
  });
}
