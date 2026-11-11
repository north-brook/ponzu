/*
 * The guided first run on the Mac: which step shows, decided again from the server's state after
 * every launch, sign-in and change, so setup picks up where it was left on any device.
 */
import type { ClaudeConnection, ClaudeMethod } from "../claude.ts";

/**
 * One row of "Where do you design?" (`GET /v1/github/accounts`): the person's own account, then
 * every account where Ponzu is installed and they are a member. GitHub does not show the person
 * organizations without the App, so only their own account can be `not_installed`.
 */
export interface GithubAccount {
  githubAccountId: number;
  login: string;
  name: string;
  avatarUrl: string | null;
  kind: "personal" | "org";
  status: "ready" | "not_installed";
  workspaceId: string | null;
  suspended: boolean;
  /** People in a ready organization's workspace: those who have signed in. */
  memberCount: number | null;
}

/** What the gates read: `GET /v1/me`, and whether this person has an iPhone signed in. */
export interface SetupFacts {
  signedIn: boolean;
  /** The person's workspaces as `/v1/me` lists them. */
  workspaces: { installed: boolean; suspended: boolean }[];
  whereConfirmed: boolean;
  claude: Pick<ClaudeConnection, "status"> | null;
  /** A claude.ai sign-in started and not yet finished, which lapses ten minutes after it began. */
  claudeSignIn: { expiresAt: string } | null;
  iphoneStepSeen: boolean;
  hasIphone: boolean;
}

export type SetupStep = "sign_in" | "where" | "claude" | "iphone" | "done";

/**
 * The first gate that is not clear, in order:
 *
 * 1. Signed out: Sign in.
 * 2. No workspace Ponzu can work in, or "Where do you design?" never confirmed: that step. It is
 *    shown once even to someone whose team already set Ponzu up, so they learn they can add more.
 * 3. No Claude at all: Connect Claude (on the code field while a sign-in is pending; see
 *    `claudeStepMode`). One that was connected and has since signed out does not send a
 *    returning person back through setup; a send asks them to reconnect instead.
 * 4. The iPhone step never seen and no iPhone signed in: Get Ponzu on your iPhone.
 * 5. Otherwise setup is done.
 */
export function setupStep(facts: SetupFacts): SetupStep {
  if (!facts.signedIn) return "sign_in";
  const ready = facts.workspaces.some((w) => w.installed && !w.suspended);
  if (!ready || !facts.whereConfirmed) return "where";
  if (!facts.claude) return "claude";
  if (!facts.iphoneStepSeen && !facts.hasIphone) return "iphone";
  return "done";
}

/** An account Ponzu can work in now: installed, and not suspended on GitHub. */
export function isReady(account: GithubAccount): boolean {
  return account.status === "ready" && !account.suspended;
}

/** Continue is live once at least one account is ready. */
export function canContinue(accounts: GithubAccount[]): boolean {
  return accounts.some(isReady);
}

/**
 * How Connect Claude stands: choosing a method, pasting claude.ai's code for a pending sign-in,
 * or entering an API key.
 */
export type ClaudeStepMode = "choose" | ClaudeMethod;

/**
 * Where Connect Claude opens, from the server's state: on the code field while a sign-in is
 * pending, so a relaunch or another device picks it up, and on the two ways otherwise. A key
 * being typed is only ever on this screen, so the server never opens on it.
 */
export function claudeStepMode(facts: SetupFacts, now: number): "choose" | "subscription" {
  const pending = facts.claudeSignIn && Date.parse(facts.claudeSignIn.expiresAt) > now;
  return pending ? "subscription" : "choose";
}
