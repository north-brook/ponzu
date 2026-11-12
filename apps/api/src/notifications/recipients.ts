import type { MemberRole, RepoPermission, WorkspaceKind } from "@ponzu/db/types";

/*
 * Who a ping goes to, as pure functions over facts the `notify` job reads first (docs/cloud.md,
 * "Notifications"). Nothing here asks GitHub or the database.
 *
 * Whether someone may read or steer a canvas is judged from the kept `repo_access` answer for
 * its repo and their membership of its workspace: `write` or `admin` to steer, `read` too to
 * read. An answer older than `ACCESS_KEPT_MS` counts as no, and so does a stale one (a webhook
 * sets its `checked_at` to the epoch). A Scratch canvas has no repo and is its owner's alone.
 * Delivery checks again at send time, so the most a lost access can cost is one ping with a
 * canvas's name in it, within the day.
 *
 * Never the person who caused it: every function takes the actor and leaves them out, whatever
 * else the facts say.
 */

/** How old a kept answer may be and still count when choosing who to ping. */
export const ACCESS_KEPT_MS = 24 * 60 * 60_000;

const READS: ReadonlySet<RepoPermission> = new Set(["admin", "write", "read"]);
const STEERS: ReadonlySet<RepoPermission> = new Set(["admin", "write"]);

/** What is known of one person and a canvas's repo. */
export interface PersonAccess {
  userId: string;
  /** Whether they are a member of the canvas's workspace now. */
  member: boolean;
  /** The kept `repo_access` answer for the canvas's repo, or null when there is none. */
  permission: RepoPermission | null;
  /** When that answer was asked. */
  checkedAt: Date | null;
}

/** A canvas, as far as choosing recipients needs it. */
export interface CanvasFacts {
  ownerId: string;
  /** No repo: the canvas is its owner's alone. */
  scratch: boolean;
  /** Everyone whose access may matter, by user id. Someone missing can do nothing. */
  people: ReadonlyMap<string, PersonAccess>;
}

function kept(person: PersonAccess | undefined, allowed: ReadonlySet<RepoPermission>, now: Date) {
  if (!person?.member || person.permission === null || person.checkedAt === null) return false;
  const age = now.getTime() - person.checkedAt.getTime();
  return age <= ACCESS_KEPT_MS && allowed.has(person.permission);
}

export function canRead(canvas: CanvasFacts, userId: string, now: Date): boolean {
  if (canvas.scratch) return userId === canvas.ownerId;
  return kept(canvas.people.get(userId), READS, now);
}

export function canSteer(canvas: CanvasFacts, userId: string, now: Date): boolean {
  if (canvas.scratch) return userId === canvas.ownerId;
  return kept(canvas.people.get(userId), STEERS, now);
}

/** Each id once, in order, without the actor and without nobody. */
function finish(ids: readonly (string | null | undefined)[], actorId: string | null): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!id || id === actorId || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * Who hears that the agent needs someone. At once (`now`): the canvas's owner, then the person
 * behind the newest delivered message, answer or comment (who is driving it), each only if they
 * can steer. After `QUESTION_ESCALATE_MS`, if the question is still open (`escalate`): every
 * other member who can steer and has opened the canvas.
 */
export function needsYouRecipients(
  canvas: CanvasFacts,
  facts: {
    stage: "now" | "escalate";
    /** The person behind the newest delivered message, answer or comment, if any. */
    driverId: string | null;
    /** Everyone with a `canvas_reads` row for the canvas: they have opened it. */
    openedBy: ReadonlySet<string>;
    actorId?: string | null;
  },
  now: Date,
): string[] {
  const actorId = facts.actorId ?? null;
  const first = finish([canvas.ownerId, facts.driverId], actorId).filter((id) =>
    canSteer(canvas, id, now),
  );
  if (facts.stage === "now") return first;
  const already = new Set([canvas.ownerId, facts.driverId]);
  return finish(
    [...canvas.people.keys()].filter(
      (id) => !already.has(id) && facts.openedBy.has(id) && canSteer(canvas, id, now),
    ),
    actorId,
  );
}

/** One person, if they can still read the canvas: a reply's commenter, a turn's person. */
export function personRecipients(
  canvas: CanvasFacts,
  facts: { personId: string | null; actorId?: string | null },
  now: Date,
): string[] {
  return finish([facts.personId], facts.actorId ?? null).filter((id) => canRead(canvas, id, now));
}

/** The canvas's owner and the pull request's author (a Ponzu person), never the actor. */
export function prRecipients(
  canvas: CanvasFacts,
  facts: { authorId: string | null; actorId?: string | null },
  now: Date,
): string[] {
  return finish([canvas.ownerId, facts.authorId], facts.actorId ?? null).filter((id) =>
    canRead(canvas, id, now),
  );
}

/** A teammate's comment: the owner, unless the owner wrote it. */
export function commentRecipients(
  canvas: CanvasFacts,
  facts: { authorId: string },
  now: Date,
): string[] {
  return finish([canvas.ownerId], facts.authorId).filter((id) => canRead(canvas, id, now));
}

/**
 * A billing ping: the workspace's admins, or for a personal workspace its person. Always on,
 * whatever their toggles say.
 */
export function billingRecipients(workspace: {
  kind: WorkspaceKind;
  members: readonly { userId: string; role: MemberRole }[];
}): string[] {
  const who =
    workspace.kind === "personal"
      ? workspace.members
      : workspace.members.filter((member) => member.role === "admin");
  return finish(
    who.map((member) => member.userId),
    null,
  );
}
