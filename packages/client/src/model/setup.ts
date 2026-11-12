/*
 * The guided first run, on the Mac and the phone: which step shows, decided again from the
 * server's state after every launch, sign-in and change, so setup picks up where it was left on
 * any device. The phone has no iPhone step: it is the iPhone.
 */
import type { Api } from "../api.ts";
import type { ClaudeConnection, ClaudeMethod } from "./claude.ts";

/**
 * One row of "Where do you build?" (`GET /v1/github/accounts`): the person's own account, then
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
 * 2. No workspace Ponzu can work in, or "Where do you build?" never confirmed: that step. It is
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

type Me = Awaited<ReturnType<Api["me"]>>;

/**
 * The gates' facts from `GET /v1/me`, and whether an iPhone is signed in as the person (their
 * devices, `GET /v1/me/notifications`): someone with Ponzu on their phone already has no need
 * of the iPhone step. A Claude sign-in in progress is the step's own (the card holds it), so
 * the gates never need it.
 *
 * The API answers no Claude at all once one is disconnected, as for someone who never had one.
 * Someone who has seen the iPhone step was through setup with a Claude connected, so for them
 * no Claude is a Claude signed out: a send asks them to connect it again, and setup does not.
 */
export function setupFacts(me: Me, hasIphone = false): SetupFacts {
  const iphoneStepSeen = me.onboarding.iphoneStepSeenAt !== null;
  return {
    signedIn: true,
    workspaces: me.workspaces.map(({ installed, suspended }) => ({ installed, suspended })),
    whereConfirmed: me.onboarding.whereConfirmedAt !== null,
    claude: me.claudeAccount
      ? { status: me.claudeAccount.status }
      : iphoneStepSeen
        ? { status: "revoked" }
        : null,
    claudeSignIn: null,
    iphoneStepSeen,
    hasIphone,
  };
}

/** The phone's steps: where you build, and Claude. It is itself the iPhone the Mac asks for. */
export type PhoneSetupStep = "where" | "claude" | "done";

/** The step the phone shows for `me`, by the Mac's own gates with the iPhone step done. */
export function phoneSetupStep(me: Me): PhoneSetupStep {
  const step = setupStep({ ...setupFacts(me, true), iphoneStepSeen: true });
  return step === "where" || step === "claude" ? step : "done";
}

/** An account Ponzu can work in now: installed, and not suspended on GitHub. */
export function isReady(account: GithubAccount): boolean {
  return account.status === "ready" && !account.suspended;
}

/**
 * An account's row in "Where do you build?": the person's own account is "Personal" over their
 * login; an organization is its name over its login (and, once ready, how many people reach
 * it), or just the login when it has no other name.
 */
export function accountLabel(account: GithubAccount): { title: string; line: string | null } {
  const personal = account.kind === "personal";
  const title = personal ? "Personal" : account.name || account.login;
  const people =
    !personal && account.status === "ready" && account.memberCount !== null
      ? ` · ${account.memberCount} ${account.memberCount === 1 ? "person" : "people"}`
      : "";
  const line = personal || title !== account.login ? `${account.login}${people}` : people.slice(3);
  return { title, line: line || null };
}

/** What came back from GitHub's install page when it was not an installation. */
export type InstallNotice = "requested" | "failed";

/** The line an install's outcome leaves under the accounts, if any. */
export function installNotice(result: string): InstallNotice | null {
  return result === "requested" || result === "failed" ? result : null;
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
