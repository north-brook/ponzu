import type { MemberWorkspace, RateCardNumbers, UsagePerson, WorkspaceUsageRead } from "@ponzu/db";
import {
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
 * who used what, by person and by design. Nothing here is billed yet: there is no card, no
 * ledger write and no cap enforcement until billing is built.
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
  /** Use put down to nobody: deleted accounts, and designs nobody's action woke. Admins only. */
  unattributedCredits: number | null;
  /**
   * Use by design, highest first: admins only. A design the viewer may not know of (in a repo
   * GitHub hides from them), or one since deleted, is counted in a last entry with no design.
   */
  byDesign: { design: { id: string; name: string } | null; usedCredits: number }[] | null;
}

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
  const byDesign = new Map<string | null, Units>();
  for (const row of read.rows) {
    const units = unitsOf(row);
    total += units;
    byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + units);
    byDesign.set(row.designId, (byDesign.get(row.designId) ?? 0) + units);
  }

  const { current } = read;
  const usedCredits = creditsOf(total);
  const free = freeCredits(read.people.length, current.freeCreditsPerMember);
  const billed = billedCredits(usedCredits, free);
  const billedCents = centsFor(billed, current.creditMicrousd);
  const capCents = read.monthlyCapCents ?? current.defaultCapCents;
  const admin = viewer.member.role === "admin";

  const personView = (person: UsagePerson): UsagePersonView => ({
    person: {
      id: person.id,
      name: person.name ?? person.githubLogin,
      login: person.githubLogin,
      avatarUrl: person.avatarUrl,
    },
    admin: person.role === "admin",
    usedCredits: creditsOf(byUser.get(person.id) ?? 0),
  });
  const mine = personView({ ...viewer.user, role: viewer.member.role });
  // Someone who reaches the workspace only through repos shared with them sees no other member
  // anywhere, so not here either.
  const seesPeople = admin && viewer.member.githubAccess !== "collaborator";

  return {
    period,
    creditCents: centsFor(1, current.creditMicrousd),
    usedCredits,
    freeCredits: free,
    billedCredits: billed,
    billedCents,
    people: read.people.length,
    cap: {
      usd: Math.floor(capCents / 100),
      isDefault: read.monthlyCapCents === null,
      lowestUsd: lowestCapUsd(billedCents),
    },
    canManage: admin,
    mine,
    byPerson: seesPeople ? highestFirst(read.people.map(personView)) : null,
    unattributedCredits: seesPeople ? creditsOf(byUser.get(null) ?? 0) : null,
    byDesign: admin ? designBreakdown(read, byDesign) : null,
  };
}

function designBreakdown(
  read: WorkspaceUsageRead,
  units: Map<string | null, Units>,
): NonNullable<WorkspaceUsage["byDesign"]> {
  const known = new Map(read.designs.map((design) => [design.id, design]));
  let hidden: Units = 0;
  const shown: NonNullable<WorkspaceUsage["byDesign"]> = [];
  for (const [id, used] of units) {
    const design = id === null ? undefined : known.get(id);
    if (!design?.readable) {
      hidden += used;
      continue;
    }
    shown.push({ design: { id: design.id, name: design.name }, usedCredits: creditsOf(used) });
  }
  const sorted = highestFirst(shown);
  return hidden > 0 ? [...sorted, { design: null, usedCredits: creditsOf(hidden) }] : sorted;
}

function highestFirst<T extends { usedCredits: number }>(rows: T[]): T[] {
  return rows.toSorted((a, b) => b.usedCredits - a.usedCredits);
}
