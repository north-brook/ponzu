import type { MemberWorkspace, RateCardNumbers, UsagePerson, WorkspaceUsageRead } from "@ponzu/db";
import {
  apportionMap,
  awakeUnits,
  billedCredits,
  centsFor,
  creditsOf,
  creditUnits,
  freeCredits,
  lowestCapUsd,
  type Units,
} from "./credits.ts";
import type { BillingPeriod } from "./period.ts";

/*
 * Plan and usage, worked out (docs/cloud.md, "Billing"): a workspace's usage this period with
 * the free credits, what would be billed and the cap, for everyone in it; and for its admins,
 * who used what, by person and by canvas. Nothing here is billed yet: there is no card and no
 * cap enforcement until billing is built. Use is read from usage events alone; the ledger holds
 * the grants and the adjustments, which add to the free credits.
 */

export interface UsagePersonView {
  person: { id: string; name: string; login: string; avatarUrl: string | null };
  admin: boolean;
  usedCredits: number;
}

export interface WorkspaceUsage {
  period: BillingPeriod;
  /** What one credit sells for, in cents. */
  creditCents: number;
  usedCredits: number;
  freeCredits: number;
  billedCredits: number;
  billedCents: number;
  /** The people the free credits are counted for. */
  people: number;
  cap: {
    usd: number;
    /** No cap was set: this is the rate card's default. */
    isDefault: boolean;
    /** The lowest it may be set to now: what has been billed, in whole dollars, or $1. */
    lowestUsd: number;
  };
  /** May change the cap (and, once billing is built, the card): an admin of the workspace. */
  canManage: boolean;
  /** The viewer's own use. */
  mine: UsagePersonView;
  /** Everyone's use, highest first: admins only, and not someone who sees no other member. */
  byPerson: UsagePersonView[] | null;
  /** Use put down to nobody: deleted accounts, and canvases nobody's action woke. Admins only. */
  unattributedCredits: number | null;
  /**
   * Use by canvas, highest first: admins only. After the named ones, canvases since deleted in
   * one entry (`deleted`), then canvases the viewer may not know of (in a repo GitHub hides from
   * them) in another (`hidden`). It adds up to `usedCredits` exactly, as `byPerson` with
   * `unattributedCredits` does.
   */
  byCanvas: CanvasUsageView[] | null;
}

export type CanvasUsageView =
  | { kind: "canvas"; canvas: { id: string; name: string }; usedCredits: number }
  | { kind: "deleted" | "hidden"; canvas: null; usedCredits: number };

export interface UsageViewer {
  user: { id: string; name: string | null; githubLogin: string; avatarUrl: string | null };
  member: Pick<MemberWorkspace, "role" | "githubAccess">;
}

export function workspaceUsage(
  read: WorkspaceUsageRead,
  period: BillingPeriod,
  viewer: UsageViewer,
): WorkspaceUsage {
  const cards = new Map(read.cards.map((card) => [card.version, card]));
  const unitsOf = (row: WorkspaceUsageRead["rows"][number]): Units => {
    const card: RateCardNumbers = cards.get(row.rateCardVersion) ?? read.current;
    return awakeUnits(row.seconds, card.sandboxCreditsPerAwakeHour) + creditUnits(row.modelCredits);
  };

  let total = 0;
  const byUser = new Map<string | null, Units>();
  const byCanvas = new Map<string | null, Units>();
  for (const row of read.rows) {
    const units = unitsOf(row);
    total += units;
    byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + units);
    byCanvas.set(row.canvasId, (byCanvas.get(row.canvasId) ?? 0) + units);
  }

  const { current } = read;
  const usedCredits = creditsOf(total);
  const counted = countedPeople(read);
  const free = freeCredits(counted, current.freeCreditsPerMember, read.adjustedCredits);
  const billed = billedCredits(usedCredits, free);
  const billedCents = centsFor(billed, current.creditMicrousd);
  const capCents = read.monthlyCapCents ?? current.defaultCapCents;
  const admin = viewer.member.role === "admin";

  // Shared out of the rounded total, so the people (and nobody) add up to it exactly.
  const userCredits = apportionMap(byUser);
  const personView = (person: UsagePerson): UsagePersonView => ({
    person: {
      id: person.id,
      name: person.name ?? person.githubLogin,
      login: person.githubLogin,
      avatarUrl: person.avatarUrl,
    },
    admin: person.role === "admin",
    usedCredits: userCredits.get(person.id) ?? 0,
  });
  // Someone who reaches the workspace only through repos shared with them sees no other member
  // anywhere, so not here either.
  const seesPeople = admin && viewer.member.githubAccess !== "collaborator";
  // Beside a list it has to add up with, the viewer's line is their share of the total. Alone, it
  // is their own use rounded down, which other people's use can never move.
  const own = personView({ ...viewer.user, role: viewer.member.role });
  const mine = seesPeople
    ? own
    : { ...own, usedCredits: creditsOf(byUser.get(viewer.user.id) ?? 0) };

  return {
    period,
    creditCents: centsFor(1, current.creditMicrousd),
    usedCredits,
    freeCredits: free,
    billedCredits: billed,
    billedCents,
    people: counted,
    cap: {
      usd: Math.floor(capCents / 100),
      isDefault: read.monthlyCapCents === null,
      lowestUsd: lowestCapUsd(billedCents),
    },
    canManage: admin,
    mine,
    byPerson: seesPeople ? highestFirst(read.people.map(personView)) : null,
    unattributedCredits: seesPeople ? (userCredits.get(null) ?? 0) : null,
    byCanvas: admin ? canvasBreakdown(read, byCanvas) : null,
  };
}

/**
 * Whom the period's free credits are counted for: everyone who has been a member at any point
 * in it (a member now, or granted an allowance this period and gone since, their account
 * deleted or not), and anyone else whose use is in it.
 */
export function countedPeople(read: Pick<WorkspaceUsageRead, "people" | "granted">): number {
  const ids = new Set([...read.people.map((person) => person.id), ...read.granted.userIds]);
  return ids.size + read.granted.departed;
}

/** The members of a period's read who have no allowance granted for it yet. */
export function ungranted(read: Pick<WorkspaceUsageRead, "people" | "granted">): string[] {
  const granted = new Set(read.granted.userIds);
  return read.people
    .filter((person) => person.role !== null && !granted.has(person.id))
    .map((person) => person.id);
}

/** The two unnamed lines' keys, beside canvases' own ids (`cnv_…`, or `des_…` for one made before the rename). */
const DELETED = "deleted";
const HIDDEN = "hidden";

/**
 * Use by canvas: each canvas the viewer may read, by name; then what was used in canvases since
 * deleted (their usage keeps no canvas); then in canvases they may not know of. Every line is
 * shared out of the rounded total, so the lines add up to it.
 */
function canvasBreakdown(
  read: WorkspaceUsageRead,
  units: Map<string | null, Units>,
): NonNullable<WorkspaceUsage["byCanvas"]> {
  const known = new Map(read.canvases.map((canvas) => [canvas.id, canvas]));
  const lines = new Map<string, Units>();
  for (const [id, used] of units) {
    const canvas = id === null ? undefined : known.get(id);
    const line = id === null ? DELETED : canvas?.readable ? canvas.id : HIDDEN;
    lines.set(line, (lines.get(line) ?? 0) + used);
  }
  const credits = apportionMap(lines);
  const named: CanvasUsageView[] = [];
  for (const line of lines.keys()) {
    const canvas = line === DELETED || line === HIDDEN ? undefined : known.get(line);
    if (!canvas) continue;
    named.push({
      kind: "canvas",
      canvas: { id: canvas.id, name: canvas.name },
      usedCredits: credits.get(line) ?? 0,
    });
  }
  const unnamed = ([DELETED, HIDDEN] as const)
    .filter((line) => lines.has(line))
    .map(
      (line): CanvasUsageView => ({
        kind: line,
        canvas: null,
        usedCredits: credits.get(line) ?? 0,
      }),
    );
  return [...highestFirst(named), ...unnamed];
}

function highestFirst<T extends { usedCredits: number }>(rows: T[]): T[] {
  return rows.toSorted((a, b) => b.usedCredits - a.usedCredits);
}
