/*
 * The kinds of email Ponzu sends (docs/cloud.md, "Email"), and what each may do:
 *
 * - `pref`: the person's switch for it (Settings › Notifications › Email), read when it is sent;
 *   null for a service email that cannot be turned off.
 * - `unsubscribe`: the category its unsubscribe link and `List-Unsubscribe` header stop; null for
 *   one that carries neither.
 * - `pausable`: whether PONZU_EMAIL_PAUSED may hold it. A legal notice never is: the terms
 *   promise it, and only the founder's script sends it.
 *
 * Pure: env.ts reads the pausable names from here, so nothing here may import the environment.
 */

export const EMAIL_KINDS = {
  /** The daily digest: opt-in, once a day. */
  digest: { pref: "emailDigest", unsubscribe: "digest", pausable: true },
  /** A billing notice to a workspace's admins: always on, no unsubscribe. */
  billing: { pref: null, unsubscribe: null, pausable: true },
  /** People joined a workspace, to its admins. */
  team: { pref: "emailTeam", unsubscribe: "team", pausable: true },
  /** The Friday recap of what the person shipped. */
  recap: { pref: "emailRecap", unsubscribe: "recap", pausable: true },
  /** A legal notice, from the founder's script only: no preference, never paused. */
  notice: { pref: null, unsubscribe: null, pausable: false },
} as const;

export type EmailKind = keyof typeof EMAIL_KINDS;

/** The kinds PONZU_EMAIL_PAUSED may name. */
export const PAUSABLE_EMAIL_KINDS = ["digest", "billing", "team", "recap"] as const;
export type PausableEmailKind = (typeof PAUSABLE_EMAIL_KINDS)[number];

/** What an unsubscribe link can stop. */
export const UNSUBSCRIBE_CATEGORIES = ["digest", "team", "recap"] as const;
export type UnsubscribeCategory = (typeof UNSUBSCRIBE_CATEGORIES)[number];

/** The preference each category turns off, as `PingPrefs` names it. */
export const UNSUBSCRIBE_PREF = {
  digest: "emailDigest",
  team: "emailTeam",
  recap: "emailRecap",
} as const satisfies Record<UnsubscribeCategory, string>;

/**
 * Who outside production may be emailed (PONZU_EMAIL_ALLOW): exact addresses and whole domains,
 * both lowercase. Null when unset: then nobody is.
 */
export interface EmailAllow {
  addresses: ReadonlySet<string>;
  domains: ReadonlySet<string>;
}

/** How this deployment sends email, besides the key and From, which belong to the seam. */
export interface EmailConfig {
  /** PONZU_EMAIL_REPLY_TO, or null. */
  replyTo: string | null;
  /** PONZU_EMAIL_ALLOW, read only outside production; null when unset. */
  allow: EmailAllow | null;
  /** PONZU_EMAIL_PAUSED: the kinds held, whose work is dropped rather than sent. */
  paused: ReadonlySet<PausableEmailKind>;
}

/** Nothing set: no Reply-To, nobody allowed outside production, nothing paused. */
export const EMAIL_CONFIG_UNSET: EmailConfig = { replyTo: null, allow: null, paused: new Set() };

/**
 * PONZU_EMAIL_ALLOW, as `a@x.com, @y.com`: null when an entry is neither an address nor
 * `@domain`, so env.ts can call it malformed.
 */
export function parseEmailAllow(text: string): EmailAllow | null {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const raw of text.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (/^@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry)) domains.add(entry.slice(1));
    else if (/^[^@\s<>,"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry)) addresses.add(entry);
    else return null;
  }
  return { addresses, domains };
}

/** Whether `address` is one PONZU_EMAIL_ALLOW names, exactly or by its whole domain. */
export function emailAllowed(allow: EmailAllow | null, address: string): boolean {
  if (!allow) return false;
  const lower = address.trim().toLowerCase();
  if (allow.addresses.has(lower)) return true;
  const at = lower.lastIndexOf("@");
  return at > 0 && allow.domains.has(lower.slice(at + 1));
}

/** PONZU_EMAIL_PAUSED, as `digest,billing`: null when it names anything else. */
export function parseEmailPaused(text: string): Set<PausableEmailKind> | null {
  const paused = new Set<PausableEmailKind>();
  for (const raw of text.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!(PAUSABLE_EMAIL_KINDS as readonly string[]).includes(entry)) return null;
    paused.add(entry as PausableEmailKind);
  }
  return paused;
}

/** Whether `kind` is held by PONZU_EMAIL_PAUSED. A notice never is. */
export function emailPaused(config: EmailConfig, kind: EmailKind): boolean {
  return EMAIL_KINDS[kind].pausable && config.paused.has(kind as PausableEmailKind);
}
