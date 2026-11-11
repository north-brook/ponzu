import type { Api } from "@ponzu/client";
import type { ClaudeConnection } from "../../cloud/claude.ts";
import type { PersonUsage, Usage } from "../../cloud/settings/billing.ts";
import type { RepoEnvironment } from "../../cloud/settings/environments.ts";
import type { Installation } from "../../cloud/settings/github.tsx";
import type { Member } from "../../cloud/settings/members.ts";
import type { PingDevice } from "../../cloud/settings/notifications.tsx";
import type { DesignUsage, TeamUsage } from "../../cloud/settings/plan.tsx";
import { toPerson } from "../map.ts";

/*
 * The API's answers as Settings' sections take them. Pure, so what each section says about the
 * person's Claude, a workspace's people and its GitHub App is tested on its own.
 */

type ClaudeView = NonNullable<Awaited<ReturnType<Api["claude"]["get"]>>["account"]>;
type WorkspaceView = Awaited<ReturnType<Api["workspaces"]["get"]>>;

/** The person's Claude as Settings › Agents shows it. */
export function toConnection(account: ClaudeView): ClaudeConnection {
  const subscription = account.kind === "subscription";
  return {
    method: account.kind,
    status: account.status,
    // The API names the plan when Claude has said ("Claude Max"), and says "Claude
    // subscription" otherwise; an API key's label ends with its last four characters.
    planLabel: subscription && account.label !== "Claude subscription" ? account.label : null,
    email: account.email,
    keyHint: subscription ? null : (/…(\S+)$/.exec(account.label)?.[1] ?? null),
    connectedAt: account.connectedAt,
    expiresAt: account.expiresAt,
  };
}

/** A workspace's people, with whether GitHub says each owns the account. */
export function toMembers(view: WorkspaceView): Member[] {
  return view.members.map((member) => ({
    person: toPerson(member.userId, member),
    role: member.role,
    owner: member.githubAccess === "owner",
  }));
}

/** The GitHub App on the workspace's account, as Settings › GitHub says it. */
export function toInstallation(view: WorkspaceView): Installation {
  const { installation, githubLogin, suspended } = view.workspace;
  return {
    state: !installation ? "not_installed" : suspended ? "suspended" : "installed",
    accountLogin: githubLogin,
    installedBy: installation?.installedBy ?? null,
    installedAt: installation?.installedAt ?? null,
  };
}

/** The installation's settings on GitHub, where its repos are chosen. */
export function installationUrl(view: WorkspaceView): string | null {
  const { installation, kind, githubLogin } = view.workspace;
  if (!installation) return null;
  return kind === "personal"
    ? `https://github.com/settings/installations/${installation.id}`
    : `https://github.com/organizations/${githubLogin}/settings/installations/${installation.id}`;
}

/** The organization's people on GitHub: who is in a workspace is decided there. */
export function peopleUrl(githubLogin: string): string {
  return `https://github.com/orgs/${githubLogin}/people`;
}

type Notifications = Awaited<ReturnType<Api["notifications"]["get"]>>;
type ApiEnvironment = Awaited<ReturnType<Api["environments"]["get"]>>["environment"];
type ApiUsage = Awaited<ReturnType<Api["usage"]["get"]>>;

/**
 * The iPhones pings can go to. A device names itself ("Maya's iPhone"); one that hasn't yet is
 * called what it is. The Mac doesn't take pings, so only phones are listed.
 */
export function toPingDevices(answer: Notifications): PingDevice[] {
  return answer.devices
    .filter((device) => device.platform === "ios")
    .map((device) => ({
      id: device.id,
      name: device.name?.trim() || "iPhone",
      pings: device.pings,
      blocked: device.blocked,
    }));
}

/** Whether an iPhone is signed in as the person: the guided setup's last step is then done. */
export function hasIphone(answer: Notifications): boolean {
  return answer.devices.some((device) => device.platform === "ios");
}

/**
 * A repo's environment as Settings shows it. A rebuild asked for happens at the repo's next
 * start (the API keeps it asked for until then), so it says that rather than that one is under
 * way; a base being built says so.
 */
export function toEnvironment(env: ApiEnvironment): RepoEnvironment {
  const { status, builtAt, stack, rebuild } = env.base;
  return {
    repo: { id: env.repo.id, owner: env.repo.owner, name: env.repo.name },
    base: {
      status: status !== "building" && rebuild.requestedAt !== null ? "requested" : status,
      builtAt: builtAt === null ? null : String(builtAt),
      stack,
    },
    secrets: env.secrets.map((secret) => ({ ...secret, updatedAt: String(secret.updatedAt) })),
  };
}

/**
 * The period's usage as Plan and usage draws it. There is no billing yet (no card, no invoices),
 * so the card is none; the cap is always there (the rate card's default until an admin sets
 * one), and the bar and the period's last day follow it.
 */
export function toUsage(usage: ApiUsage): Usage {
  return {
    usedCredits: usage.usedCredits,
    freeCredits: usage.freeCredits,
    creditUsd: usage.creditCents / 100,
    capUsd: usage.cap.usd,
    periodEnd: String(usage.period.end),
    card: null,
    notBilled: usage.billing.status === "not_set_up",
  };
}

/** A team's share of the period: everyone's, for an admin; only their own for anyone else. */
export function toTeamUsage(usage: ApiUsage, name: string): TeamUsage {
  const row = (p: ApiUsage["mine"]): PersonUsage => ({
    person: {
      id: p.person.id,
      name: p.person.name,
      login: p.person.login,
      avatarUrl: p.person.avatarUrl,
    },
    admin: p.admin,
    usedCredits: p.usedCredits,
  });
  return {
    name,
    people: usage.people,
    byPerson: usage.byPerson?.map(row) ?? null,
    unattributedCredits: usage.unattributedCredits ?? 0,
    mine: row(usage.mine),
  };
}

/** Use by design, for an admin; the unnamed rows last: deleted designs, then those they can't open. */
export function toDesignUsage(usage: ApiUsage): DesignUsage[] | null {
  return (
    usage.byDesign?.map(({ kind, design, usedCredits }) => ({
      kind,
      id: design?.id ?? null,
      name: design?.name ?? null,
      usedCredits,
    })) ?? null
  );
}
