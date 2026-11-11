import type { Api } from "@ponzu/client";
import type { ClaudeConnection } from "../../cloud/claude.ts";
import type { Installation } from "../../cloud/settings/github.tsx";
import type { Member } from "../../cloud/settings/members.ts";
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
