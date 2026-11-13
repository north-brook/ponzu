/*
 * When the phone asks about pings (iPhone design §12, onboarding §4.12): never at launch or in
 * onboarding, only right after a comment the person sent from this phone, when iOS has not been
 * asked yet. "Not now" is kept, and the sheet comes back once, after a later comment at least
 * seven days on; then never, and Settings is the way in. What was asked is about the phone, not
 * the person, so it is kept across sign-outs (`KEPT_KEYS` in lib/cloud/sign-out.ts).
 *
 * Pure, with the time handed in; the storage is whatever the caller gives (AsyncStorage).
 */

/** Where the ask's history is kept on this phone. */
export const PING_ASK_KEY = "ponzu.pingAsk";

/** How long after "Not now" the sheet may come back, once. */
export const REASK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** What iOS says of Ponzu's notifications, in the words the rules use. */
export type PingPermission = "undetermined" | "granted" | "denied";

/** What the phone has asked so far. */
export interface PingAsk {
  /** How many times the sheet showed: 0, 1 or 2. */
  times: number;
  /** When it last showed (ms). */
  askedAt: number | null;
  /** When the person last chose Not now, or swiped the sheet away (ms). */
  declinedAt: number | null;
}

export const NEVER_ASKED: PingAsk = { times: 0, askedAt: null, declinedAt: null };

/**
 * After a comment sent from this phone: `ask` shows the sheet, `register` registers without one
 * (iOS already allows pings), `none` does nothing.
 *
 * - Pings are off at the API (`GET /v1/me` says `features.push` is false): nothing is asked,
 *   since a yes would bring nothing and read as broken.
 * - Allowed already: register, no sheet.
 * - Refused in iOS: never a sheet (Settings says where to turn them on).
 * - Not asked yet: the sheet, once; after a Not now, once more 7 days on; then never.
 */
export function afterComment(input: {
  pushOn: boolean;
  permission: PingPermission;
  ask: PingAsk;
  now: number;
}): "ask" | "register" | "none" {
  if (!input.pushOn) return "none";
  if (input.permission === "granted") return "register";
  if (input.permission === "denied") return "none";
  const { times, askedAt, declinedAt } = input.ask;
  if (times <= 0) return "ask";
  if (times >= 2) return "none";
  // Shown once. A sheet left without an answer (the app closed under it) counts as Not now.
  const declined = declinedAt ?? askedAt;
  if (declined === null) return "ask";
  return input.now - declined >= REASK_AFTER_MS ? "ask" : "none";
}

/** The sheet was shown at `now`. */
export const asked = (ask: PingAsk, now: number): PingAsk => ({
  ...ask,
  times: ask.times + 1,
  askedAt: now,
});

/** Not now, or the sheet swiped away, at `now`. */
export const declined = (ask: PingAsk, now: number): PingAsk => ({ ...ask, declinedAt: now });

/** What was kept, read back; anything unreadable is as if never asked. */
export function parseAsk(raw: string | null): PingAsk {
  if (!raw) return NEVER_ASKED;
  try {
    const value = JSON.parse(raw) as Partial<PingAsk>;
    const time = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);
    const times = typeof value.times === "number" && value.times >= 0 ? Math.floor(value.times) : 0;
    return { times, askedAt: time(value.askedAt), declinedAt: time(value.declinedAt) };
  } catch {
    return NEVER_ASKED;
  }
}

export interface AskStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export async function readAsk(storage: AskStorage): Promise<PingAsk> {
  try {
    return parseAsk(await storage.getItem(PING_ASK_KEY));
  } catch {
    return NEVER_ASKED;
  }
}

export async function writeAsk(storage: AskStorage, ask: PingAsk): Promise<void> {
  try {
    await storage.setItem(PING_ASK_KEY, JSON.stringify(ask));
  } catch {
    // Not kept: the worst is one ask too many, after the next comment.
  }
}
