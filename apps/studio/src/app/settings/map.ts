import type { Api } from "@ponzu/client";
import type { ClaudeConnection } from "../../cloud/claude.ts";
import { cardBrand, type PersonUsage, type Usage } from "../../cloud/settings/billing.ts";
import type { RepoEnvironment } from "../../cloud/settings/environments.ts";
import type { Installation } from "../../cloud/settings/github.tsx";
import type { Member } from "../../cloud/settings/members.ts";
import type { PingDevice } from "../../cloud/settings/notifications.tsx";
import type { CanvasUsage, TeamUsage } from "../../cloud/settings/plan.tsx";
import { githubPersonId, toPerson } from "../map.ts";

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

/**
 * A workspace's people: everyone GitHub says can reach it, with whether each has opened Ponzu
 * and whether GitHub says they own the account. An API from before `people` lists only those
 * who have opened Ponzu.
 */
export function toMembers(view: WorkspaceView): Member[] {
  const people = (view as { people?: WorkspaceView["people"] }).people;
  if (!people) {
    return view.members.map((member) => ({
      person: toPerson(member.userId, member),
      joined: true,
      role: member.role,
      owner: member.githubAccess === "owner",
    }));
  }
  return people.map((someone): Member => {
    const owner = someone.githubAccess === "owner";
    return someone.userId !== null && someone.role !== null
      ? { person: toPerson(someone.userId, someone), joined: true, role: someone.role, owner }
      : {
          person: toPerson(githubPersonId(someone.githubUserId), someone),
          joined: false,
          role: null,
          owner,
        };
  });
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
 * The devices pings can go to: the person's Macs (their banners) and iPhones (their pushes),
 * this one first, as "This Mac". A device names itself ("Maya's MacBook Pro"); one that hasn't
 * is called what it is. Otherwise in the order the API lists them.
 */
export function toPingDevices(
  answer: Notifications,
  thisDevice: string | null = null,
): PingDevice[] {
  const devices = answer.devices.flatMap((device): PingDevice[] => {
    const mac = device.platform === "macos";
    if (!mac && device.platform !== "ios") return [];
    return [
      {
        id: device.id,
        kind: mac ? "mac" : "iphone",
        name:
          device.id === thisDevice ? "This Mac" : device.name?.trim() || (mac ? "Mac" : "iPhone"),
        pings: device.pings,
        blocked: device.blocked,
      },
    ];
  });
  const here = devices.findIndex((device) => device.id === thisDevice);
  if (here > 0) devices.unshift(...devices.splice(here, 1));
  return devices;
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
 * The period's usage as Plan and usage draws it. While the API doesn't bill (billing off or
 * observing: `not_set_up`) there is no card and nothing is billed, and the cap is always there
 * (the rate card's default until an admin sets one), as Ponzu 2.1 showed it. Once it bills
 * (`on`), an admin sees the card and what is past due; without a card the cap is left out, so
 * the bar spans the free credits alone (the billing plan's no-card state).
 */
export function toUsage(usage: ApiUsage): Usage {
  const on = usage.billing.status === "on";
  const given = on ? usage.billing.card : null;
  const card = given ? { brand: cardBrand(given.brand), last4: given.last4 } : null;
  const pastDue = on ? usage.billing.pastDue : null;
  return {
    usedCredits: usage.usedCredits,
    freeCredits: usage.freeCredits,
    creditUsd: usage.creditCents / 100,
    capUsd: on && !card ? null : usage.cap.usd,
    periodEnd: String(usage.period.end),
    card,
    notBilled: !on,
    ...(on
      ? {
          pastDue: pastDue ? { reason: pastDue.reason, invoiceUrl: pastDue.invoiceUrl } : null,
        }
      : {}),
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

/** Use by canvas, for an admin; the unnamed rows last: deleted canvases, then those they can't open. */
export function toCanvasUsage(usage: ApiUsage): CanvasUsage[] | null {
  return (
    usage.byCanvas?.map(({ kind, canvas, usedCredits }) => ({
      kind,
      id: canvas?.id ?? null,
      name: canvas?.name ?? null,
      usedCredits,
    })) ?? null
  );
}
