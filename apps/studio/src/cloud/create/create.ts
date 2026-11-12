import type { Repo } from "../model.ts";

/** What a new canvas is made in: a repo, or Scratch. */
export type ProjectChoice = { kind: "repo"; repo: Repo } | { kind: "scratch" };

/**
 * One workspace as the picker lists it: its name (its group's heading), and the repos the person
 * can push to there; `repos` is null while they load. A workspace whose repos couldn't be had is
 * given with none: its Scratch is still offered.
 */
export interface Shelf {
  /** Null for the window's own workspace. */
  workspaceId: string | null;
  name: string;
  repos: Repo[] | null;
}

/** Another workspace's shelf, as the window passes the others in, in the switcher's order. */
export interface RepoShelf extends Shelf {
  workspaceId: string;
}

/** A repo as the picker and its trigger title it: `north-brook/fernwood`. */
export function fullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

/** What the selector says: a repo's full name, or Scratch. */
export function projectLabel(choice: ProjectChoice): string {
  return choice.kind === "scratch" ? "Scratch" : fullName(choice.repo);
}

/**
 * What the selector says to assistive tech: the project, and for Scratch whose it is (on screen
 * the sidebar says so), since every workspace has one.
 */
export function projectName(choice: ProjectChoice, workspace: string | null): string {
  return choice.kind === "scratch" && workspace
    ? `Project: Scratch in ${workspace}`
    : `Project: ${projectLabel(choice)}`;
}

/** A prompt can be sent once it says something, and not twice while the first is going. */
export function canSend(prompt: string, sending: boolean): boolean {
  return !sending && prompt.trim().length > 0;
}

/**
 * One workspace's part of the picker's list: its heading (none when it is the only one), its
 * Scratch, then its repos; `loading` while its repos are still to come.
 */
export interface PickerGroup {
  /** Null for the window's own workspace. */
  workspaceId: string | null;
  /** The heading over the group, or null with a single workspace. */
  heading: string | null;
  scratch: boolean;
  repos: Repo[];
  loading: boolean;
}

/**
 * The picker's list for a query, grouped by workspace in the shelves' order: the window's first
 * (pushed-to lately first, as given), then each other workspace's in the order the workspace
 * switcher lists them. Each group is its heading, its Scratch, and its repos; with one workspace
 * there is no heading, and the list is Scratch and the repos. A repo listed already (a workspace
 * sharing one) is not listed twice.
 *
 * A query keeps the repos whose full name (`owner/name`) contains it anywhere, so an
 * organization's name finds its repos, and every Scratch for "scratch". With several workspaces
 * a workspace's name, shown in its heading, finds its Scratch and all its repos. A group with
 * nothing that matches is left out, heading and all.
 */
export function pickerGroups(shelves: readonly Shelf[], query: string): PickerGroup[] {
  const q = query.trim().toLowerCase();
  const has = (text: string) => !q || text.toLowerCase().includes(q);
  const several = shelves.length > 1;
  const seen = new Set<string>();
  const groups: PickerGroup[] = [];
  for (const shelf of shelves) {
    const named = several && q !== "" && has(shelf.name);
    const repos = (shelf.repos ?? []).filter((repo) => {
      if (seen.has(repo.id)) return false;
      seen.add(repo.id);
      return named || has(fullName(repo));
    });
    const scratch = named || has("scratch");
    // While a search is typed, a group still loading has nothing to show for it yet.
    const loading = shelf.repos === null && !q;
    if (!scratch && !repos.length && !loading) continue;
    groups.push({
      workspaceId: shelf.workspaceId,
      heading: several ? shelf.name : null,
      scratch,
      repos,
      loading,
    });
  }
  return groups;
}

/**
 * The shelves the open picker lists. Only the last workspace's repos join while it is open, at
 * the list's foot: anyone else's would push the groups under them down, under the pointer. Each
 * other workspace keeps what it had as the picker opened, and repos that answered since wait
 * until it is next opened. With one workspace, it is the last.
 */
export function heldWhileOpen(atOpening: readonly Shelf[], now: readonly Shelf[]): Shelf[] {
  return now.map((shelf, i) =>
    i === now.length - 1
      ? shelf
      : {
          ...shelf,
          // One still loading as it opened lists no repos until then, rather than a placeholder
          // that would wait the whole time it is open.
          repos: atOpening.find((was) => was.workspaceId === shelf.workspaceId)?.repos ?? [],
        },
  );
}

/** A row's height in the picker's list: the menus' one-line row. */
export const ROW = 32;
/** A group's heading: the menus' section label (`menuLabelClass`, 6 over its 14 of line over 4). */
export const HEADING = 24;
/**
 * What the list shows before it scrolls: five rows and half of the next, so a longer list reads
 * as longer.
 */
export const LIST_ROOM = 5.5 * ROW;

/** The rule between two groups: the menus' separator (`menuSeparatorClass`, 5 over 1 over 5). */
export const BETWEEN = 11;

/**
 * How tall the list is with these groups: their headings and the rules between them, then their
 * Scratch rows, repos and loading rows.
 */
export function listHeight(groups: readonly PickerGroup[]): number {
  return groups.reduce(
    (sum, group, i) =>
      sum +
      (group.heading === null ? 0 : HEADING + (i > 0 ? BETWEEN : 0)) +
      ROW * (Number(group.scratch) + group.repos.length + Number(group.loading)),
    0,
  );
}

/**
 * Whether the picker offers a search, decided as it opens and held while it is open (a field
 * brought in over the rows would move them): whenever the list would scroll, or while the last
 * workspace's repos are still to come, since they join at the foot and may make it scroll. The
 * others' don't join while it is open (`heldWhileOpen`), so they don't count.
 */
export function searchAtOpening(groups: readonly PickerGroup[]): boolean {
  return listHeight(groups) > LIST_ROOM || groups.at(-1)?.loading === true;
}

/**
 * The create page's measures (create-page.tsx). The composer is docked at the foot of the main
 * pane, `DOCK_INSET` above its bottom edge: the distance the thread's composer keeps from the
 * rail's (AppWindow pads the rail 10 at its foot), the place it travels to on a send.
 */
export const DOCK_INSET = 10;
/** The composer's height at rest: one line and its controls (composer.tsx's `min-h`). */
export const COMPOSER_REST = 118;
/** The mark's size, and the gap between it and the statement under it. */
export const MARK = 56;
export const MARK_GAP = 24;
/**
 * How far over the pane's true centre the hero's centre sits, as a share of the pane's height
 * (5%: 45 in a pane of 900), so it scales with the window: where the eye puts the middle.
 */
export const HERO_RISE = 0.05;
/**
 * The statement's room: its two lines, the words (the display face at 28, a 35 line) over the
 * repo's selector (40). Scratch's one line keeps it, so the mark and the first line hold still
 * whichever is chosen, and while the project is still being found.
 */
export const STATEMENT_ROOM = 35 + 40;
/** The least room kept between the statement and the composer, and above the hero at the top. */
export const HERO_GAP = 40;
export const HERO_TOP = 24;

/**
 * Where the statement's top goes, in a pane `pane` tall with the composer `dock` tall (its card
 * and its inset) and the statement `statement` tall; and whether the mark over it shows.
 *
 * The hero (the mark over the statement) is centred in the pane, `HERO_RISE` of its height high
 * of true centre, so it holds still while the composer grows with what is typed or attached.
 * Only once the composer would come within `HERO_GAP` of the statement does
 * the statement give way, rising ahead of it; the mark goes once that would take it past
 * `HERO_TOP`, and the statement rises on to `HERO_TOP`, where the pane scrolls rather than let
 * the two overlap.
 */
export function heroPlace({
  pane,
  dock,
  statement,
}: {
  pane: number;
  dock: number;
  statement: number;
}): { top: number; mark: boolean } {
  const above = MARK + MARK_GAP;
  const centred = (pane - (above + statement)) / 2 - pane * HERO_RISE + above;
  const clear = pane - dock - HERO_GAP - statement;
  const top = Math.round(Math.max(HERO_TOP, Math.min(centred, clear)));
  return { top, mark: top - above >= HERO_TOP };
}
