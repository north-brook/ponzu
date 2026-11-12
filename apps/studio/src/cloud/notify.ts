import type { NotificationRow } from "@ponzu/client";
import type { DeepLink, MacNotice } from "@ponzu/desktop/bridge";

/*
 * The Mac's own notifications, as rules (docs/cloud.md, "Notifications"): which rows of the
 * person's live inbox (`me.notifications`) show a banner, which banners go, which rows are read
 * because the person is looking at them, and the dock's number. Pure: app/notifications.ts runs
 * them on each change of the inbox and hands the shell what they say.
 *
 * A banner's words are the row's, which are Ponzu's own (a canvas's or workspace's name and a
 * fixed sentence); nothing here reads or adds anything a person or the agent wrote.
 */

/** A row made this long before the app opened still banners: it arrived as the app started. */
export const LAUNCH_GRACE_MS = 60_000;
/** Past this age a row is news no more, and shows no banner. */
export const FRESH_MS = 10 * 60_000;
/** Input this recent, with the window focused, means the person is at this Mac. */
export const ACTIVE_INPUT_MS = 120_000;
/** How often the API hears that the person is at this Mac, while they are. */
export const ACTIVE_BEAT_MS = 60_000;

export interface BannerContext {
  /** When this launch of the app began. */
  launchedAt: number;
  now: number;
  /** The banners already shown this launch, by `bannerKey`. */
  shown: ReadonlySet<string>;
  /** This Mac's pings are on (Settings › Notifications › Where). */
  pings: boolean;
  /** The canvas the person is looking at: the window focused and visible with it open. */
  looking: string | null;
}

/**
 * What a banner stands for: a row as it was when shown. A teammate's comments fold into one row
 * (its words and `updatedAt` change, its id stays), and the fold is news of its own: the same
 * id with a new key replaces the banner rather than adding one.
 */
export function bannerKey(row: NotificationRow): string {
  return `${row.id}@${newsAt(row)}`;
}

/** When a row last became news: a folded comment row when it last folded, any other when made. */
function newsAt(row: NotificationRow): string {
  return row.kind === "teammate_comment" ? row.updatedAt : row.createdAt;
}

/** A needs-you whose question has closed: answered, withdrawn or gone. */
function settled(row: NotificationRow): boolean {
  return row.kind === "needs_you" && row.resolvedAt !== null;
}

/**
 * Whether a row shows a banner now: it is unread, unmuted and still open, not yet shown this
 * launch as it now stands, new (made since just before the app opened, and in the last ten
 * minutes, so opening the app never floods), this Mac's pings are on, and the person is not
 * looking at its canvas (then it is read instead: `isLooking`).
 */
export function shouldBanner(row: NotificationRow, ctx: BannerContext): boolean {
  if (row.muted || row.readAt !== null || settled(row)) return false;
  if (ctx.shown.has(bannerKey(row))) return false;
  const at = Date.parse(newsAt(row));
  if (!(at >= ctx.launchedAt - LAUNCH_GRACE_MS && at >= ctx.now - FRESH_MS)) return false;
  return ctx.pings && !isLooking(row, ctx.looking);
}

/** The person is looking at the canvas the row is about: it is news to nobody. */
export function isLooking(row: NotificationRow, looking: string | null): boolean {
  return looking !== null && row.canvasId === looking;
}

/** The dock's number: open needs-you questions across every workspace, read, muted or not. */
export function badgeCount(rows: readonly NotificationRow[]): number {
  return rows.filter((row) => row.kind === "needs_you" && row.resolvedAt === null).length;
}

export interface InboxStep {
  /** Banners to show, oldest first. */
  show: NotificationRow[];
  /** Rows to mark read (`via: "mac"`): unread, about the canvas the person is looking at. */
  read: string[];
  /** Banners to take away: their rows left the inbox, were read, or their question closed. */
  remove: string[];
  badge: number;
}

/**
 * What to do as the inbox changes: `rows` as it stands now, and `showing` the ids of the
 * banners this launch has up.
 */
export function inboxStep(
  rows: readonly NotificationRow[],
  showing: ReadonlySet<string>,
  ctx: BannerContext,
): InboxStep {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const remove = [...showing].filter((id) => {
    const row = byId.get(id);
    return !row || row.readAt !== null || settled(row);
  });
  const read = rows
    .filter((row) => row.readAt === null && !settled(row) && isLooking(row, ctx.looking))
    .map((row) => row.id);
  const show = rows
    .filter((row) => shouldBanner(row, ctx))
    .sort((a, b) => Date.parse(newsAt(a)) - Date.parse(newsAt(b)));
  return { show, read, remove, badge: badgeCount(rows) };
}

/**
 * Where a click on the row's banner goes, in the link grammar every client shares, naming the
 * row so opening it reads it: its canvas (its thread, pull request or a comment's pin), or Plan
 * and usage for a workspace's billing ping. Null for a row that names nowhere.
 */
export function linkOfRow(row: NotificationRow): DeepLink | null {
  const { link } = row;
  if (row.canvasId === null) {
    return link.open === "usage"
      ? {
          kind: "settings",
          section: "usage",
          // Its own workspace's plan, whichever the window shows.
          ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
          notificationId: row.id,
        }
      : null;
  }
  return {
    kind: "canvas",
    canvasId: row.canvasId,
    open: link.open,
    ...(link.pageId ? { pageId: link.pageId } : {}),
    ...(link.artboardId ? { artboardId: link.artboardId } : {}),
    ...(link.commentThreadId ? { commentThreadId: link.commentThreadId } : {}),
    ...(link.questionId ? { questionId: link.questionId } : {}),
    notificationId: row.id,
  };
}

/** The banner the shell shows for a row, grouped by its canvas (or workspace); null for none. */
export function noticeOfRow(row: NotificationRow): MacNotice | null {
  const link = linkOfRow(row);
  const groupId = row.canvasId ?? row.workspaceId;
  if (!link || !groupId) return null;
  return {
    id: row.id,
    groupId,
    title: row.title,
    ...(row.subtitle ? { subtitle: row.subtitle } : {}),
    body: row.body,
    link,
  };
}

/** Whether the person is at this Mac: its window focused, with a key, a click or a scroll lately. */
export function isActive(at: { focused: boolean; lastInputAt: number; now: number }): boolean {
  return at.focused && at.now - at.lastInputAt <= ACTIVE_INPUT_MS;
}

/**
 * The time zone to tell the API, when the one it keeps differs from this computer's: the daily
 * email comes at 9:00 there. Null when they agree, or this computer names none.
 */
export function timeZoneToSend(kept: string | null, here: string | undefined): string | null {
  return here && here !== kept ? here : null;
}
