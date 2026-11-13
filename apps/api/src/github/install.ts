import {
  consumeAuthState,
  createAuthState,
  getAuthState,
  type Json,
  recordAuthStateOutcome,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";
import type { Binding } from "../vault/vault.ts";
import { type LinkTarget, linkTargetOf } from "./link-scheme.ts";
import { syncGithub } from "./sync.ts";

/*
 * The install round trip. An app asks for a link (`createInstallLink`); the person installs the
 * App on GitHub; GitHub sends their browser to the App's Setup URL with an installation id and
 * the `state` the link carried (`finishSetup`). The app hears how it went from the setup page's
 * link, or, when it takes no links or the link went unanswered, by asking (`installStatus`):
 * the outcome is written on the state's row as the page is made.
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
 * Where to send the person to install the App, with a state good for one return. With no
 * `githubAccountId` it is GitHub's account picker: every account of theirs, to install the App
 * on one or change the repos of one that has it. GitHub may preselect `githubAccountId` on its
 * page, and may not: whichever account they pick is the one the setup page records. `id` is the app's handle on the install, for `installStatus`.
 */
export async function createInstallLink(
  { db, clock, vault, config }: Pick<Deps, "db" | "clock" | "vault" | "config">,
  userId: string,
  {
    client,
    githubAccountId,
    scheme,
  }: { client: InstallClient; githubAccountId?: number; scheme?: LinkTarget },
): Promise<{ id: string; url: string; expiresAt: Date }> {
  const expiresAt = new Date(clock.now() + STATE_LIFETIME_MS);
  // Where the setup page links back to rides in the row, never in the link. An app that says
  // nothing is not known: null, and its page links nowhere (link-scheme.ts).
  const state = await createAuthState(db, {
    kind: "github_install",
    userId,
    payload: { client, scheme: scheme ?? null },
    expiresAt,
  });
  // With no account to suggest, GitHub's account picker, asked for by name. Its plain install
  // page (`installations/new`) only shows the picker until the App is installed somewhere: after
  // that it goes straight to that installation's settings, where no other account can be picked.
  const app = `https://github.com/apps/${config.githubApp.slug}/installations`;
  const url = new URL(
    githubAccountId === undefined ? `${app}/select_target` : `${app}/new/permissions`,
  );
  if (githubAccountId !== undefined) url.searchParams.set("target_id", String(githubAccountId));
  url.searchParams.set("state", await vault.seal(state.id, STATE_BINDING));
  // The row's id is the person's own and answers only to their session; the sealed state is
  // what GitHub carries, and only it finishes the round trip.
  return { id: state.id, url: url.toString(), expiresAt };
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

export const SETUP_RESULTS: readonly SetupPage["kind"][] = [
  "installed",
  "requested",
  "pending",
  "sign_in",
  "failed",
];

/**
 * Finish a return from GitHub's install page. Parameters are as GitHub sent them, unchecked.
 * Also says which app to send the person back to: the one that asked for the link, as its state
 * recorded it (a scheme, or `none` for a build that takes no links), or null when nothing says
 * (`link-scheme.ts`).
 */
export async function finishSetup(
  deps: Pick<Deps, "db" | "clock" | "vault" | "github" | "log" | "analytics" | "mail" | "config">,
  query: {
    state?: string;
    installationId?: number;
    setupAction?: "install" | "update" | "request";
  },
): Promise<{ page: SetupPage; target: LinkTarget | null }> {
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
    return { page: { kind: "pending" }, target: null };
  }
  const payload: Json = state.payload ?? {};
  const target = linkTargetOf(payload.scheme);
  const page = await settle(deps, state.userId, query);
  const outcome =
    page.kind === "installed"
      ? { result: page.kind, workspaceId: page.workspace.id }
      : { result: page.kind };
  try {
    await recordAuthStateOutcome(db, {
      id: state.id,
      kind: "github_install",
      payload: { ...payload, outcome },
    });
  } catch (error) {
    // The page still says how it went; the app catches up by its link or its next sync.
    log.error("github_setup_unrecorded", { error });
  }
  log.info("github_setup_page", { result: page.kind, target: target ?? "unknown" });
  return { page, target };
}

/** How an install an app started stands, as `GET /v1/github/installs/:id` answers it. */
export type InstallStatus =
  /** GitHub hasn't sent the browser back yet, or the page is being made. */
  | { status: "waiting"; expiresAt: Date }
  /** It came back, and this is what the page said. */
  | { status: "settled"; result: SetupPage["kind"]; workspaceId: string | null }
  /** Nobody came back in time. */
  | { status: "expired" };

/** Where `userId`'s install `id` stands, or null when there is no such install of theirs. */
export async function installStatus(
  { db, clock }: Pick<Deps, "db" | "clock">,
  userId: string,
  id: string,
): Promise<InstallStatus | null> {
  const state = await getAuthState(db, { id, kind: "github_install", userId });
  if (!state) return null;
  const outcome = state.payload?.outcome as { result?: unknown; workspaceId?: unknown } | undefined;
  const result = SETUP_RESULTS.find((kind) => kind === outcome?.result);
  if (state.consumedAt && result) {
    const workspaceId = typeof outcome?.workspaceId === "string" ? outcome.workspaceId : null;
    return { status: "settled", result, workspaceId };
  }
  // Taken, with the outcome not written yet: the page is on its way. One whose outcome could not
  // be written is waited on until its time is up, like one nobody came back from.
  if (state.expiresAt.getTime() <= clock.now()) return { status: "expired" };
  return { status: "waiting", expiresAt: state.expiresAt };
}

async function settle(
  deps: Pick<Deps, "db" | "clock" | "vault" | "github" | "log" | "analytics" | "mail" | "config">,
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
