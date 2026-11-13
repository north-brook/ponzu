import {
  DIGEST_DEFAULT_TIME_ZONE,
  enqueueJob,
  type Job,
  notifyCanvasFacts,
  type RecapMerge,
  recapMerges,
  recapPerson,
  recapsDue,
  stampQuietRecaps,
  stampRecapSent,
} from "@ponzu/db";
import { type RecapCanvas, renderEmail } from "@ponzu/email";
import { z } from "zod";
import type { Deps } from "../deps/index.ts";
import { type JobDeps, type RunningJob, runJob } from "../jobs/run.ts";
import { canvasFactsOf } from "../notifications/facts.ts";
import { canRead } from "../notifications/recipients.ts";
import { emailPaused } from "./kinds.ts";
import { canvasHref } from "./links.ts";
import { sendEmail } from "./send.ts";

/*
 * The Friday recap (docs/cloud.md, "Email"): on Fridays from 15:00 where the person is, the pull
 * requests merged that week from canvases they own, in weeks when there were any.
 *
 * Every five minutes the cron's `recaps` step first stamps, in one statement, everyone due whose
 * week had no merge from a canvas they own (`stampQuietRecaps`): most people, most weeks. Then
 * it records an `email.recap` job for each of up to `RECAP_BATCH` people who have something to
 * be sent (`recapsDue`), keyed `recap:<user>:<Friday>`, and runs them one after another past the
 * response, as the digest does. A Friday missed entirely is skipped, never caught up later.
 *
 * The job reads the week's merges (`recapMerges`), and keeps a canvas only while the person
 * still owns it, is still a member of its workspace now, and could read it when it was last
 * merged (`canRead` at that canvas's newest merge, not now: a kept access answer counts for a
 * day, and the recap is for people who have not opened Ponzu since). It sends one email through
 * `sendEmail` with Resend's key `recap/<user>/<Friday>` and stamps `recap_sent_on` (and, on the
 * first real send, `recap_first_sent_at`, which drops the email's one-time introduction from
 * every later one). With nothing left to say it only stamps.
 *
 * The email carries canvas names, workspace names and pull request numbers at most: never a
 * pull request's title (the agent wrote it), a repository, or anything else a person wrote. In
 * the counts-only form (`RECAP_FORM`) it carries no canvas name at all.
 *
 * With email off nothing is read, stamped or recorded. While `recap` is in PONZU_EMAIL_PAUSED the
 * step does nothing, and a job recorded before stamps the Friday without sending.
 */

export const RECAP_JOB = "email.recap";

/**
 * How many recaps one run of the step sends. They go one after another, each within the mail
 * seam's deadline, so a batch ends well inside a job's lock; at one run every five minutes that
 * is 240 an hour, and the people with nothing merged never take a place in it.
 */
export const RECAP_BATCH = 20;

/**
 * What the recap shows, the founder's choice (the email plan's §1.6): "names" lists each canvas
 * by name with its pull request numbers; "counts" says only how many canvases and pull requests
 * ("Shipped this week: 2 canvases, 3 pull requests merged"), with no canvas or workspace name in
 * the subject, preview or body. Counts until the founder says otherwise: names of canvases from
 * private repositories would otherwise go to personal mailboxes by default.
 */
export const RECAP_FORM: "names" | "counts" = "counts";

const RecapPayload = z.object({
  userId: z.string().min(1).max(64),
  /** The Friday it is for, in the person's zone: `YYYY-MM-DD`. */
  friday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The zone the week is computed in, as the step found it. */
  timeZone: z.string().min(1).max(128),
});

/** The job's key. */
export function recapJobKey(userId: string, friday: string): string {
  return `recap:${userId}:${friday}`;
}

/** The email's idempotency key. */
export function recapEmailKey(userId: string, friday: string): string {
  return `recap/${userId}/${friday}`;
}

/** Whether a recap may be recorded now: email is on and `recap` is not paused. */
function recapEmailOn(deps: Pick<Deps, "mail" | "config">): boolean {
  return deps.mail.enabled && !emailPaused(deps.config.email, "recap");
}

const HOUR_MS = 60 * 60_000;

/**
 * Whether it can be Friday 15:00 or later, and still Friday, anywhere at `now`: from 15:00 on
 * Friday at UTC+14 (01:00 UTC on Friday) until midnight at UTC-12 (12:00 UTC on Saturday),
 * with an hour's margin each side. Outside it nobody can be due, so the step asks the database
 * nothing for the rest of the week.
 */
export function recapMayBeDue(now: Date): boolean {
  const day = now.getUTCDay();
  const fridayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - ((day + 2) % 7),
  );
  const since = now.getTime() - fridayStart;
  return since < 37 * HOUR_MS;
}

/**
 * The cron's step: stamp the quiet, then record and send the recaps of up to `RECAP_BATCH`
 * people with a merge in their week. Nothing, not even a read, while email is off or `recap` is
 * paused, or outside the hours when it can be Friday afternoon somewhere.
 */
export async function enqueueRecaps(
  deps: JobDeps & Pick<Deps, "background">,
  now: Date,
): Promise<{ stamped: number; due: number; recorded: number }> {
  if (!recapEmailOn(deps) || !recapMayBeDue(now)) return { stamped: 0, due: 0, recorded: 0 };
  const stamped = await stampQuietRecaps(deps.db, { now });
  const due = await recapsDue(deps.db, {
    now,
    limit: RECAP_BATCH,
    job: { kind: RECAP_JOB, keyPrefix: "recap" },
  });
  const worker = `${RECAP_JOB}:${crypto.randomUUID()}`;
  const held: Job[] = [];
  for (const { userId, friday, timeZone } of due) {
    const job = await enqueueJob(deps.db, {
      kind: RECAP_JOB,
      key: recapJobKey(userId, friday),
      payload: { userId, friday, timeZone },
      runAt: now,
      lockedBy: worker,
    });
    if (job) held.push(job);
  }
  if (held.length > 0) {
    deps.background(
      RECAP_JOB,
      (async () => {
        for (const job of held) await runJob(deps, job, worker);
      })(),
    );
  }
  return { stamped, due: due.length, recorded: held.length };
}

/** A canvas's merges in the week, newest merge first. */
interface CanvasWeek {
  canvasId: string;
  name: string;
  workspaceName: string;
  /** Its pull request numbers, in merge order, each once. */
  numbers: number[];
  newest: Date;
}

/** The week's merges by canvas: newest merge first, each canvas's numbers in merge order. */
export function groupMerges(merges: readonly RecapMerge[]): CanvasWeek[] {
  const byCanvas = new Map<string, CanvasWeek>();
  const oldestFirst = [...merges].sort((a, b) => a.mergedAt.getTime() - b.mergedAt.getTime());
  for (const merge of oldestFirst) {
    const week = byCanvas.get(merge.canvasId) ?? {
      canvasId: merge.canvasId,
      name: merge.canvasName,
      workspaceName: merge.workspaceName,
      numbers: [],
      newest: merge.mergedAt,
    };
    if (!week.numbers.includes(merge.number)) week.numbers.push(merge.number);
    if (merge.mergedAt > week.newest) week.newest = merge.mergedAt;
    byCanvas.set(merge.canvasId, week);
  }
  return [...byCanvas.values()].sort(
    (a, b) => b.newest.getTime() - a.newest.getTime() || a.canvasId.localeCompare(b.canvasId),
  );
}

/** A zone Intl can format in: the one given, or the default when Intl does not know it. */
function intlZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return DIGEST_DEFAULT_TIME_ZONE;
  }
}

/** "Tuesday": the weekday of `at` in `timeZone`. */
export function weekdayIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: intlZone(timeZone) }).format(
    at,
  );
}

/** "Friday, November 13", from the local date `YYYY-MM-DD`. */
export function recapDateLine(friday: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${friday}T12:00:00Z`));
}

/**
 * The canvases the person may still be told about: they own it now, they are a member of its
 * workspace now, and they could read it when it was last merged.
 */
async function readableWeeks(
  deps: Pick<JobDeps, "db">,
  userId: string,
  weeks: readonly CanvasWeek[],
): Promise<CanvasWeek[]> {
  const kept: CanvasWeek[] = [];
  for (const week of weeks) {
    const facts = await notifyCanvasFacts(deps.db, { canvasId: week.canvasId });
    if (!facts || facts.ownerId !== userId) continue;
    if (!facts.people.some((person) => person.userId === userId)) continue;
    if (!canRead(canvasFactsOf(facts), userId, week.newest)) continue;
    kept.push(week);
  }
  return kept;
}

/** The `email.recap` job: one person's recap for one Friday. */
export async function runRecapJob(
  deps: JobDeps,
  payload: unknown,
  _job: RunningJob,
): Promise<void> {
  const { db, log, clock } = deps;
  const { userId, friday, timeZone } = RecapPayload.parse(payload);
  const job = recapJobKey(userId, friday);
  if (!deps.mail.enabled) {
    log.info("recap_skipped", { userId, reason: "mail_off" });
    return;
  }
  const person = await recapPerson(db, userId);
  // A deleted account: nothing to send, nobody to stamp.
  if (!person) return;
  if (person.recapSentOn !== null && person.recapSentOn >= friday) return;
  const now = () => new Date(clock.now());
  if (emailPaused(deps.config.email, "recap")) {
    // Paused means dropped: this Friday is skipped.
    log.info("email_paused", { kind: "recap", job });
    await stampRecapSent(db, { userId, friday, sent: false, now: now() });
    return;
  }

  const weeks = await readableWeeks(
    deps,
    userId,
    groupMerges(await recapMerges(db, { userId, friday, timeZone })),
  );
  if (weeks.length === 0) {
    await stampRecapSent(db, { userId, friday, sent: false, now: now() });
    log.info("recap_empty", { userId });
    return;
  }

  const canvases: RecapCanvas[] = weeks.map((week) => ({
    name: week.name,
    href: canvasHref(deps.config.build.environment, week.canvasId, { open: "pull-request" }),
    workspaceName: week.workspaceName,
    numbers: week.numbers,
    weekday: weekdayIn(week.newest, timeZone),
  }));
  // Read before the send and not changed by it, so a retry renders the same email.
  const first = person.recapFirstSentAt === null;
  // The one door (send.ts): it reads the address and switch now, and throws RetryLater when
  // Resend could not take the email, so the job goes again with the same key.
  const outcome = await sendEmail(deps, {
    kind: "recap",
    userId,
    key: recapEmailKey(userId, friday),
    render: ({ unsubscribeUrl }) =>
      renderEmail("recap", {
        date: recapDateLine(friday),
        canvases,
        first,
        countsOnly: RECAP_FORM === "counts",
        unsubscribeUrl: unsubscribeUrl!,
      }),
  });
  if (outcome === "off") return;
  // Sent, or done with for good (refused, held, paused, turned off since): this Friday is done.
  await stampRecapSent(db, {
    userId,
    friday,
    sent: outcome === "sent" || outcome === "duplicate",
    now: now(),
  });
  log.info("recap_done", {
    userId,
    outcome,
    canvases: canvases.length,
    pullRequests: canvases.reduce((sum, canvas) => sum + canvas.numbers.length, 0),
  });
}
