import {
  enqueueJob,
  type Job,
  stampMembersAnnounced,
  type TeamEmailWorkspace,
  teamEmailAdmins,
  teamEmailWorkspace,
  teamJoiners,
  teamSize,
} from "@ponzu/db";
import { renderEmail } from "@ponzu/email";
import { z } from "zod";
import type { Deps } from "../deps/index.ts";
import type { JobDeps, RunningJob } from "../jobs/run.ts";
import { emailPaused } from "./kinds.ts";
import { type SendOutcome, sendEmail } from "./send.ts";

/*
 * People joined (docs/cloud.md, "Email"): when people join an organisation's workspace, its
 * admins hear who, in one email at most once a day.
 *
 * A join is a person's own sign-in sync making their membership (`upsertMembership` answering
 * `created`) of an organisation's workspace that they reach on GitHub as its owner or a member,
 * when they are not the person who installed the App. Then `noteJoined` records an
 * `email.members` job for the workspace, due at `until = greatest(now + 1 hour,
 * members_announced_at + 24 hours)`, so joins gather for an hour and the workspace's admins hear
 * at most once a day. A later join while that job waits folds into it.
 *
 * The job announces the memberships made in `(greatest(members_announced_at, until - 48 hours),
 * until]` that still exist, sends each admin who reaches the organisation as its owner or a
 * member (never an outside collaborator an admin promoted, never one of the people announced)
 * one email through `sendEmail`, and then moves `members_announced_at` to `until`. The 48-hour
 * floor matters because the column's default is the moment the migration ran: without it, the
 * first email after email is switched on would announce everyone who joined since.
 *
 * The job's key names the window it starts from, `members:<workspace>:<members_announced_at>`,
 * rather than the workspace alone. A join that lands after `until` while the job is still
 * running folds into it and is outside its window, so once the job has stamped it looks for
 * such joins and records the next job, due 24 hours after `until`. Keyed by the workspace alone,
 * that next job would be refused while the running one still counts as waiting. And a job
 * whose window start has moved since it was recorded (another job stamped first, or the stamp
 * at first release ran) sends nothing: it only makes sure whoever joined since is scheduled.
 *
 * With email off nothing is recorded or sent. While `team` is in PONZU_EMAIL_PAUSED nothing is
 * recorded, and a job recorded before stamps its window without sending: those joins are not
 * announced later.
 */

export const MEMBERS_JOB = "email.members";

/** How long joins gather before the email goes. */
export const MEMBERS_GATHER_MS = 60 * 60_000;
/** The least time between two of a workspace's emails. */
export const MEMBERS_SPACING_MS = 24 * 60 * 60_000;
/** How far back from `until` a window ever reaches. */
export const MEMBERS_FLOOR_MS = 48 * 60 * 60_000;

const MembersPayload = z.object({
  workspaceId: z.string().min(1).max(64),
  /** `members_announced_at` when the job was recorded: where its window starts. */
  since: z.iso.datetime(),
  /** Where its window ends: when it was due. */
  until: z.iso.datetime(),
});

/** What scheduling an email reads. */
type ScheduleDeps = Pick<Deps, "db" | "clock" | "log" | "mail" | "config">;

/** The job's key: the workspace and where its window starts. */
export function membersJobKey(workspaceId: string, since: Date): string {
  return `members:${workspaceId}:${since.toISOString()}`;
}

/** One admin's email, and its idempotency key. */
export function membersEmailKey(workspaceId: string, until: Date, adminUserId: string): string {
  return `members/${workspaceId}/${until.toISOString()}/${adminUserId}`;
}

/** Whether a people-joined email may be recorded now: email is on and `team` is not paused. */
function teamEmailOn(deps: Pick<Deps, "mail" | "config">): boolean {
  return deps.mail.enabled && !emailPaused(deps.config.email, "team");
}

/**
 * Someone just joined an organisation's workspace as its owner or a member, and is not its
 * installer (the caller checks those): record the email that will announce them, unless one
 * that will is already waiting. Nothing while email is off or `team` is paused.
 */
export async function noteJoined(deps: ScheduleDeps, workspaceId: string): Promise<Job | null> {
  if (!deps.mail.enabled) return null;
  if (emailPaused(deps.config.email, "team")) {
    // Paused means dropped: move the window's start past this join, so the first email after
    // `team` is released never announces it. A millisecond on, because the database stamps
    // `created_at` in microseconds and the clock counts milliseconds. Never moves it back.
    await stampMembersAnnounced(deps.db, { workspaceId, until: new Date(deps.clock.now() + 1) });
    return null;
  }
  const workspace = await teamEmailWorkspace(deps.db, workspaceId);
  if (!workspace || workspace.kind !== "org") return null;
  return schedule(deps, workspace);
}

/** Record the workspace's next email, folding into one already waiting for the same window. */
function schedule(deps: ScheduleDeps, workspace: TeamEmailWorkspace): Promise<Job | null> {
  const since = workspace.membersAnnouncedAt;
  const until = new Date(
    Math.max(deps.clock.now() + MEMBERS_GATHER_MS, since.getTime() + MEMBERS_SPACING_MS),
  );
  return enqueueJob(deps.db, {
    kind: MEMBERS_JOB,
    key: membersJobKey(workspace.id, since),
    payload: {
      workspaceId: workspace.id,
      since: since.toISOString(),
      until: until.toISOString(),
    },
    runAt: until,
  });
}

/**
 * Record the workspace's next email if anyone it would announce joined after where its window
 * now starts: for joins that landed while a job ran, after its window had closed.
 */
async function scheduleIfJoined(deps: ScheduleDeps, workspaceId: string): Promise<Job | null> {
  if (!teamEmailOn(deps)) return null;
  const workspace = await teamEmailWorkspace(deps.db, workspaceId);
  if (!workspace || workspace.kind !== "org") return null;
  const [late] = await teamJoiners(deps.db, {
    workspaceId,
    after: workspace.membersAnnouncedAt,
    installedByUserId: workspace.installedByUserId,
    limit: 1,
  });
  return late ? schedule(deps, workspace) : null;
}

/** The `email.members` job: one workspace's people-joined email, one to each admin. */
export async function runMembersJob(
  deps: JobDeps,
  payload: unknown,
  _job: RunningJob,
): Promise<void> {
  const { db, log } = deps;
  const parsed = MembersPayload.parse(payload);
  const { workspaceId } = parsed;
  const since = new Date(parsed.since);
  const until = new Date(parsed.until);
  const job = membersJobKey(workspaceId, since);
  if (!deps.mail.enabled) {
    log.info("members_skipped", { workspaceId, reason: "mail_off" });
    return;
  }
  const workspace = await teamEmailWorkspace(db, workspaceId);
  if (!workspace || workspace.kind !== "org") return;
  if (workspace.membersAnnouncedAt.getTime() !== since.getTime()) {
    // Another job, or the stamp at first release, moved the window on: this one's joins were
    // announced or dropped already. Anyone who joined since is the next email's.
    log.info("members_skipped", { workspaceId, reason: "window_moved" });
    await scheduleIfJoined(deps, workspaceId);
    return;
  }
  if (emailPaused(deps.config.email, "team")) {
    // Paused means dropped: the window closes without an email, and nothing more is recorded.
    log.info("email_paused", { kind: "team", job });
    await stampMembersAnnounced(db, { workspaceId, until });
    return;
  }

  const joiners = await teamJoiners(db, {
    workspaceId,
    after: new Date(Math.max(since.getTime(), until.getTime() - MEMBERS_FLOOR_MS)),
    until,
    installedByUserId: workspace.installedByUserId,
  });
  const outcomes: Partial<Record<SendOutcome, number>> = {};
  if (joiners.length > 0) {
    const announced = new Set(joiners.map((joiner) => joiner.userId));
    const admins = (await teamEmailAdmins(db, workspaceId)).filter((id) => !announced.has(id));
    const total = await teamSize(db, { workspaceId, until });
    const people = joiners.map(({ name, login }) => ({ name, login }));
    for (const admin of admins) {
      // The one door (send.ts): it reads the admin's address and switch now, and throws
      // RetryLater when Resend could not take the email, so the job goes again with the same
      // keys and Resend sends each admin's email once.
      const outcome = await sendEmail(deps, {
        kind: "team",
        userId: admin,
        key: membersEmailKey(workspaceId, until, admin),
        render: ({ unsubscribeUrl }) =>
          renderEmail("team", {
            workspaceName: workspace.name,
            people,
            total,
            unsubscribeUrl: unsubscribeUrl!,
          }),
      });
      // Email was switched off meanwhile: leave the window for when it is on again.
      if (outcome === "off") return;
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
  }

  // Every admin has been handled: the window is done with.
  await stampMembersAnnounced(db, { workspaceId, until });
  log.info("members_done", { workspaceId, joined: joiners.length, ...outcomes });
  await scheduleIfJoined(deps, workspaceId);
}
