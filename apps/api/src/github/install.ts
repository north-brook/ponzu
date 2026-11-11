import { consumeAuthState, createAuthState } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import type { Binding } from "../vault/vault.ts";
import { DEFAULT_LINK_SCHEME, type LinkScheme, linkSchemeOf } from "./link-scheme.ts";
import { syncGithub } from "./sync.ts";

/*
 * The install round trip. An app asks for a link (`createInstallLink`); the person installs the
 * App on GitHub; GitHub sends their browser to the App's Setup URL with an installation id and
 * the `state` the link carried (`finishSetup`).
 *
 * That request comes from a browser with no Ponzu credential, and every part of it can be
 * forged. The `state` says who started the round trip: it is sealed with the API's key (a
 * forged or altered one does not open) and names a row that can be taken once, for fifteen
 * minutes. The installation id is never trusted: the person's own GitHub token has to reach
 * that installation, which the sync finds out by asking GitHub.
 */

const STATE_LIFETIME_MS = 15 * 60_000;
const STATE_BINDING: Binding = { column: "auth_states.id", row: "github_install" };

export type InstallClient = "mac" | "ios";

/**
 * Where to send the person to install the App, with a state good for one return. GitHub may
 * preselect `githubAccountId` on its page, and may not: whichever account they pick is the
 * one the setup page records.
 */
export async function createInstallLink(
  { db, clock, vault, config }: Pick<Deps, "db" | "clock" | "vault" | "config">,
  userId: string,
  {
    client,
    githubAccountId,
    scheme = DEFAULT_LINK_SCHEME,
  }: { client: InstallClient; githubAccountId?: number; scheme?: LinkScheme },
): Promise<{ url: string; expiresAt: Date }> {
  const expiresAt = new Date(clock.now() + STATE_LIFETIME_MS);
  // The scheme the setup page links back to rides in the row, never in the link.
  const state = await createAuthState(db, {
    kind: "github_install",
    userId,
    payload: { client, scheme: linkSchemeOf(scheme) },
    expiresAt,
  });
  const base = `https://github.com/apps/${config.githubApp.slug}/installations/new`;
  const url = new URL(githubAccountId === undefined ? base : `${base}/permissions`);
  if (githubAccountId !== undefined) url.searchParams.set("target_id", String(githubAccountId));
  url.searchParams.set("state", await vault.seal(state.id, STATE_BINDING));
  return { url: url.toString(), expiresAt };
}

/** What the setup page tells the person. */
export type SetupOutcome =
  /** Their token reaches the installation and its workspace is up to date. */
  | { kind: "installed"; workspace: { id: string; name: string } }
  /** They asked an organization's owners to install it; nothing exists until one does. */
  | { kind: "requested" }
  /**
   * Nothing here says who they are (no state, or one that is forged, used or out of time), or
   * their token does not reach that installation. Someone who really installed the App is
   * caught up by its webhook and their next sync, so the page says no more than that.
   */
  | { kind: "pending" }
  /** GitHub no longer takes the token Ponzu holds for them: they have to sign in again. */
  | { kind: "sign_in" };

/** The page: an outcome, or GitHub failing on the way. */
export type SetupPage = SetupOutcome | { kind: "failed" };

/**
 * Finish a return from GitHub's install page. Parameters are as GitHub sent them, unchecked.
 * Also says which app to send the person back to: the one that asked for the link, as its state
 * recorded it, or Ponzu when the state says nothing (`link-scheme.ts`).
 */
export async function finishSetup(
  deps: Pick<Deps, "db" | "clock" | "vault" | "github" | "log">,
  query: {
    state?: string;
    installationId?: number;
    setupAction?: "install" | "update" | "request";
  },
): Promise<{ page: SetupPage; scheme: LinkScheme }> {
  const { db, clock, vault, log } = deps;
  const stateId = query.state && (await vault.open(query.state, STATE_BINDING).catch(() => null));
  const state =
    stateId &&
    (await consumeAuthState(db, {
      id: stateId,
      kind: "github_install",
      now: new Date(clock.now()),
    }));
  if (!state) {
    // Installed from github.com directly, or a link that was used, ran out, or was made up.
    log.info("github_setup_unclaimed", { stateGiven: query.state !== undefined });
    return { page: { kind: "pending" }, scheme: DEFAULT_LINK_SCHEME };
  }
  const payload = state.payload as { scheme?: unknown } | null;
  const scheme = linkSchemeOf(payload?.scheme);
  return { page: await settle(deps, state.userId, query), scheme };
}

async function settle(
  deps: Pick<Deps, "db" | "clock" | "vault" | "github" | "log">,
  userId: string,
  query: { installationId?: number; setupAction?: "install" | "update" | "request" },
): Promise<SetupPage> {
  const { log } = deps;
  if (query.setupAction === "request") return { kind: "requested" };
  if (query.installationId === undefined) return { kind: "pending" };

  let workspaces: Awaited<ReturnType<typeof syncGithub>>;
  try {
    workspaces = await syncGithub(deps, userId);
  } catch (error) {
    if (error instanceof ApiError && error.code === "github_reauth_required") {
      return { kind: "sign_in" };
    }
    // The state is spent; the page still knows which app to send the person back to.
    log.error("github_setup_failed", { error });
    return { kind: "failed" };
  }
  const workspace = workspaces.find(
    ({ installationId }) => installationId === query.installationId,
  );
  if (!workspace) {
    log.warn("github_setup_unreachable", { userId, installationId: query.installationId });
    return { kind: "pending" };
  }
  log.info("github_setup_finished", { userId, workspaceId: workspace.id });
  return { kind: "installed", workspace: { id: workspace.id, name: workspace.name } };
}
