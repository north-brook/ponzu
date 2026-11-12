import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appLink, parseAppLink } from "@ponzu/core/links";
import type { DeepLink, MacNotice } from "./bridge.ts";

/*
 * The Mac's own notifications: banners the studio asks for from the person's live inbox, and the
 * dock's badge. Nothing is pushed to a Mac (docs/cloud.md, "Notifications"); while Ponzu runs,
 * the studio hears its inbox and says what to show, and this shows it with Electron's
 * `Notification`.
 *
 * What the studio sends is checked here as if anyone had sent it: ids, words of a bounded
 * length, and a link that is exactly one of ours. A banner's words are Ponzu's own (a canvas's
 * name and a fixed sentence), and none of them is logged.
 */

/** The longest title, subtitle or body the API keeps (the notifications table's own check). */
const TEXT_MAX = 200;
/** Ids as the link grammar takes them. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** An install id as the API takes it. */
const INSTALL_ID = /^[A-Za-z0-9-]{16,64}$/;
/**
 * How many shown banners are kept hold of. Electron's notification loses its events once it is
 * collected, so each is kept until it is clicked, closed or taken away; past this many the
 * oldest is let go (it stays in Notification Center, and a click on it just opens Ponzu).
 */
export const KEPT_MAX = 50;
/** The most the dock is asked to count. */
const BADGE_MAX = 9999;

/** Electron's `Notification`, as much of it as this needs; a test hands in its own. */
export interface NotificationClass {
  new (options: {
    id: string;
    groupId: string;
    title: string;
    subtitle?: string;
    body: string;
    silent: boolean;
  }): ShownNotification;
  /** Takes delivered notifications out of Notification Center, by id (macOS). */
  remove?(ids: string[]): void;
}

export interface ShownNotification {
  on(event: "click" | "close", listener: () => void): unknown;
  on(event: "failed", listener: (event: unknown, error: string) => void): unknown;
  show(): void;
  close(): void;
}

export interface Notifier {
  /** Show a banner the studio sent; anything that isn't exactly a notice is dropped. */
  show(value: unknown): void;
  remove(value: unknown): void;
  setBadge(value: unknown): void;
  /** How many banners are kept hold of now. */
  readonly kept: number;
}

export function createNotifier(deps: {
  Notification: NotificationClass;
  /** `app.setBadgeCount`: the Mac's dock, Linux's launcher; nothing on Windows. */
  setBadge: (count: number) => void;
  /** A banner clicked: Ponzu comes forward and the studio gets its link. */
  open: (link: DeepLink) => void;
  /** The system wouldn't show one: an unsigned build's are refused. */
  failed: (id: string) => void;
}): Notifier {
  const kept = new Map<string, ShownNotification>();
  const forget = (id: string, shown: ShownNotification) => {
    if (kept.get(id) === shown) kept.delete(id);
  };
  return {
    show(value) {
      const notice = noticeOf(value);
      if (!notice) return;
      // The same id again (a teammate's comments folding into one row) replaces the banner.
      const was = kept.get(notice.id);
      if (was) {
        kept.delete(notice.id);
        was.close();
      }
      const shown = new deps.Notification({
        id: notice.id,
        groupId: notice.groupId,
        title: notice.title,
        ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
        body: notice.body,
        silent: false,
      });
      shown.on("click", () => {
        forget(notice.id, shown);
        deps.open(notice.link);
      });
      shown.on("close", () => forget(notice.id, shown));
      shown.on("failed", () => {
        forget(notice.id, shown);
        deps.failed(notice.id);
      });
      kept.set(notice.id, shown);
      while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
      shown.show();
    },
    remove(value) {
      if (!Array.isArray(value)) return;
      const ids = value.filter((id): id is string => typeof id === "string" && ID.test(id));
      if (!ids.length) return;
      for (const id of ids) {
        const shown = kept.get(id);
        kept.delete(id);
        shown?.close();
      }
      // Those let go of, or shown before a reload, are still in Notification Center.
      deps.Notification.remove?.(ids);
    },
    setBadge(value) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return;
      deps.setBadge(Math.min(value, BADGE_MAX));
    },
    get kept() {
      return kept.size;
    },
  };
}

/** `value` as a notice, when it is exactly one: otherwise null. */
export function noticeOf(value: unknown): MacNotice | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown): x is string =>
    typeof x === "string" && x.trim().length > 0 && x.length <= TEXT_MAX;
  if (typeof v.id !== "string" || !ID.test(v.id)) return null;
  if (typeof v.groupId !== "string" || !ID.test(v.groupId)) return null;
  if (!text(v.title) || !text(v.body)) return null;
  if (v.subtitle !== undefined && !text(v.subtitle)) return null;
  const link = linkOf(v.link);
  if (!link) return null;
  return {
    id: v.id,
    groupId: v.groupId,
    title: v.title,
    ...(v.subtitle ? { subtitle: v.subtitle as string } : {}),
    body: v.body,
    link,
  };
}

/**
 * A banner's link, written out and read back through the grammar every client shares, so only
 * what a `ponzu://` link could say survives. A banner opens a canvas or Settings, nothing else.
 */
function linkOf(value: unknown): DeepLink | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== "canvas" && kind !== "settings") return null;
  try {
    const link = parseAppLink(appLink(value as DeepLink, "ponzu"), "ponzu");
    return link && link.kind !== "auth_callback" ? link : null;
  } catch {
    return null;
  }
}

/**
 * This install's id: made once and kept in the app's data folder. It names the install to the
 * API and nothing more (it opens nothing), so it is a plain file beside the encrypted session
 * rather than in the keychain, which a launch with nobody signed in never asks. A file that
 * isn't one (cut short, edited) is made again.
 */
export function installIdIn(file: string, make: () => string = randomUUID): string {
  if (existsSync(file)) {
    try {
      const kept = readFileSync(file, "utf8").trim();
      if (INSTALL_ID.test(kept)) return kept;
    } catch {
      // Unreadable: made again below.
    }
  }
  const id = make();
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, id, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    // Not kept: this launch still has one, and the next makes another (one more device row).
    console.error(`Couldn't keep this install's id: ${error}`);
  }
  return id;
}

/** The computer's name as Settings lists it: its host name without `.local`; null for none. */
export function deviceNameOf(hostname: string): string | null {
  const name = hostname.replace(/\.local\.?$/i, "").trim();
  return name ? name.slice(0, 100) : null;
}
