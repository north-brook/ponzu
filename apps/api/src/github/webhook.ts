import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getRepoInstallationId,
  getUserByGithubId,
  getWorkspaceByInstallation,
  markDefaultBranchPushed,
  markRepoAccessStale,
} from "@ponzu/db";
import { z } from "zod";
import type { Deps } from "../deps/index.ts";
import { reviewApproved } from "../notifications/notify.ts";
import { reconcileInstallation } from "./installations.ts";
import { readPeopleSoon } from "./people.ts";
import {
  type PullRequestRef,
  refreshAfterPush,
  refreshCanvases,
  tellCanvases,
  withdrawRepoPictures,
} from "./pull-requests.ts";
import { forgetRevokedAuthorization } from "./revoked.ts";
import { resyncGithubUser, resyncWorkspaceMembers } from "./sync.ts";

/*
 * GitHub's webhooks: which deliveries mean something to Ponzu, and the work each one starts.
 *
 * A delivery is a signal, not a record. GitHub sends one late, twice, or after a later one, so
 * nothing here writes what a payload says about an installation or its repos: it asks GitHub
 * for the installation as it is now (`reconcileInstallation`), syncs the people it concerns, or
 * reads a canvas's pull request again (`refreshCanvases`). Every handler can run again with the
 * same delivery and change nothing more, but for the news it tells a canvas's agent.
 *
 * Only the fields used are read; the schemas below are that list.
 */

/** Whether `header` is GitHub's signature of exactly these bytes, compared in constant time. */
// Not `@octokit/webhooks-methods`: it takes the body as a string, and this checks the raw bytes.
export function verifySignature(secret: string, body: Uint8Array, header: string | undefined) {
  const signature = /^sha256=([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export type WebhookDeps = Pick<
  Deps,
  | "db"
  | "clock"
  | "vault"
  | "github"
  | "log"
  | "sandboxes"
  | "runnerBundle"
  | "poke"
  | "storage"
  | "config"
  | "analytics"
  | "push"
  | "mail"
>;
type Work = (deps: WebhookDeps) => Promise<void>;

export type Plan =
  /**
   * `payload` is the delivery's payload with only the fields used: what is kept while the work
   * waits to run. Planned again, it plans the same work.
   */
  | { kind: "work"; payload: unknown; work: Work }
  /** An event or action Ponzu does not act on. */
  | { kind: "ignored" }
  /** An event Ponzu acts on, in a shape it does not recognise. */
  | { kind: "malformed" };

const Id = z.object({ id: z.number().int() });
const Head = z.object({ ref: z.string(), repo: Id.nullable() });
const PullRequest = z.object({ number: z.number().int(), head: Head });

const InstallationEvent = z.object({
  action: z.string(),
  installation: Id,
  sender: Id,
  requester: Id.nullish(),
});
const InstallationScoped = z.object({ installation: Id });
const RepositoryEvent = z.object({
  action: z.string(),
  repository: Id,
  installation: Id.optional(),
  changes: z.object({ default_branch: z.unknown().optional() }).optional(),
});
const MemberEvent = z.object({ action: z.string(), member: Id, installation: Id.optional() });
const OrganizationEvent = z.object({
  action: z.string(),
  membership: z.object({ user: Id.nullable() }).optional(),
  installation: Id.optional(),
});
const TeamEvent = z.object({
  action: z.string(),
  installation: Id,
  changes: z.object({ repository: z.unknown().optional() }).optional(),
});
const AuthorizationEvent = z.object({ action: z.string(), sender: Id });
const PullRequestEvent = z.object({
  action: z.string(),
  repository: Id,
  pull_request: PullRequest,
});
const PushEvent = z.object({
  ref: z.string(),
  repository: Id.extend({ default_branch: z.string() }),
});
const CheckRunEvent = z.object({
  action: z.string(),
  repository: Id,
  check_run: z.object({
    name: z.string(),
    conclusion: z.string().nullable(),
    head_sha: z.string(),
    details_url: z.string().nullish(),
    html_url: z.string().nullish(),
    pull_requests: z.array(PullRequest),
  }),
});
const CheckSuiteEvent = z.object({
  action: z.string(),
  repository: Id,
  check_suite: z.object({
    conclusion: z.string().nullable(),
    head_sha: z.string(),
    app: z.object({ name: z.string() }).nullish(),
    pull_requests: z.array(PullRequest),
  }),
});
const ReviewEvent = z.object({
  action: z.string(),
  repository: Id,
  review: z.object({
    // Optional only for deliveries recorded before it was kept: they ping nobody.
    id: z.number().int().optional(),
    state: z.string(),
    body: z.string().nullable(),
    html_url: z.string(),
    user: z.object({ id: z.number().int(), login: z.string() }).nullable(),
    author_association: z.string(),
  }),
  // Its author, for the approval's ping.
  pull_request: PullRequest.extend({ user: z.object({ login: z.string() }).nullish() }),
});

const INSTALLATION_ACTIONS = [
  "created",
  "deleted",
  "suspend",
  "unsuspend",
  "new_permissions_accepted",
];
const REPOSITORY_ACTIONS = ["renamed", "transferred", "deleted", "privatized", "publicized"];
/** The repository actions after which who may read or push to it is asked again. */
const ACCESS_CHANGING_REPOSITORY_ACTIONS = ["transferred", "deleted", "privatized", "publicized"];
const TEAM_ACTIONS = ["added_to_repository", "removed_from_repository", "deleted"];
const PULL_REQUEST_ACTIONS = [
  "opened",
  "closed",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "edited",
  "auto_merge_enabled",
  "auto_merge_disabled",
];
/**
 * A check run created changes nothing a read would not see from the push that made it, and
 * there is one for every check of every push.
 */
const CHECK_RUN_ACTIONS = ["completed", "rerequested"];
const REVIEW_ACTIONS = ["submitted", "edited", "dismissed"];
/** Check conclusions that are something the agent should hear about. */
const FAILED = ["failure", "timed_out", "action_required", "startup_failure"];
/** The most of a review's text a canvas's feed keeps. */
const REVIEW_BODY_CHARS = 4_000;
/**
 * Whose reviews are worth asking about: the repo's owner, its organization's members and its
 * collaborators. On a public repo anyone can review a pull request, and a review is text the
 * agent reads, so a stranger's is dropped at once; of these, only one GitHub says can push to
 * the repo reaches the agent (`tellCanvases`).
 */
const REVIEWERS = ["OWNER", "MEMBER", "COLLABORATOR"];

/** What to do with one delivery of `event`, decided from its payload alone. */
export function planDelivery(event: string, payload: unknown): Plan {
  switch (event) {
    case "installation":
      return plan(InstallationEvent, payload, (e) => {
        if (!INSTALLATION_ACTIONS.includes(e.action)) return null;
        return async (deps) => {
          const installer =
            e.action === "created" ? await getUserByGithubId(deps.db, e.sender.id) : null;
          const workspace = await reconcileInstallation(deps, e.installation.id, {
            installedByUserId: installer?.id ?? null,
          });
          if (workspace) await readPeopleSoon(deps, e.installation.id);
          if (!workspace || e.action !== "created") return;
          // Whoever installed it, and whoever asked an owner to, can reach it now.
          for (const person of new Set([e.sender.id, e.requester?.id])) {
            if (person !== undefined) await resyncGithubUser(deps, person);
          }
        };
      });

    case "installation_repositories":
    case "installation_target":
      // Repos joined or left the installation: what anyone may do in its repos is asked again.
      return plan(
        InstallationScoped,
        payload,
        (e) => (deps) => reconcileAndRecheck(deps, e.installation.id),
      );

    case "repository":
      return plan(RepositoryEvent, payload, (e) => {
        const defaultBranchChanged = e.action === "edited" && e.changes?.default_branch;
        if (!REPOSITORY_ACTIONS.includes(e.action) && !defaultBranchChanged) return null;
        const accessChanged = ACCESS_CHANGING_REPOSITORY_ACTIONS.includes(e.action);
        return async (deps) => {
          if (accessChanged)
            await markRepoAccessStale(deps.db, { githubRepoIds: [e.repository.id] });
          await reconcileRepository(deps, e.repository.id, e.installation?.id);
          if (e.action === "publicized") await withdrawRepoPictures(deps, e.repository.id);
        };
      });

    case "member":
    case "membership":
      // A collaborator added to or removed from a repo; someone added to or removed from a team.
      return plan(MemberEvent, payload, (e) => {
        const lostAccessTo = e.action === "removed" ? e.installation?.id : undefined;
        return (deps) =>
          andThenPeople(deps, e.installation?.id, () =>
            resyncGithubUser(deps, e.member.id, { lostAccessTo }),
          );
      });

    case "organization":
      return plan(OrganizationEvent, payload, (e) => {
        const person = e.membership?.user?.id;
        if ((e.action === "member_added" || e.action === "member_removed") && person) {
          const lostAccessTo = e.action === "member_removed" ? e.installation?.id : undefined;
          return (deps) =>
            andThenPeople(deps, e.installation?.id, () =>
              resyncGithubUser(deps, person, { lostAccessTo }),
            );
        }
        const installationId = e.installation?.id;
        if (e.action === "renamed" && installationId) {
          return (deps) => reconcileKnownInstallation(deps, installationId);
        }
        return null;
      });

    case "team":
      // A team gained or lost a repo, or its access to one changed. The payload does not say
      // who is on the team, so everyone in the workspace is synced.
      return plan(TeamEvent, payload, (e) => {
        const accessChanged =
          TEAM_ACTIONS.includes(e.action) || (e.action === "edited" && e.changes?.repository);
        if (!accessChanged) return null;
        return (deps) =>
          andThenPeople(deps, e.installation.id, () =>
            resyncWorkspaceMembers(deps, e.installation.id),
          );
      });

    case "github_app_authorization":
      return plan(AuthorizationEvent, payload, (e) => {
        if (e.action !== "revoked") return null;
        return (deps) => forgetRevokedAuthorization(deps, e.sender.id);
      });

    // Each of these makes the canvas's pull request be read again from GitHub. A failed check
    // and a review are also news for the agent, told after the read: a read that fails runs
    // again with the job, and the news is told once.

    case "pull_request":
      return plan(PullRequestEvent, payload, (e) => {
        if (!PULL_REQUEST_ACTIONS.includes(e.action)) return null;
        return (deps) =>
          refreshCanvases(deps, { githubRepoId: e.repository.id, pullRequests: [e.pull_request] });
      });

    case "push":
      return plan(PushEvent, payload, (e) => {
        const branch = /^refs\/heads\/(.+)$/.exec(e.ref)?.[1];
        if (!branch) return null;
        return async (deps) => {
          // What the repo's ideas were made from has moved: they are due at the next ask.
          if (branch === e.repository.default_branch) {
            await markDefaultBranchPushed(deps.db, {
              githubRepoId: e.repository.id,
              at: new Date(deps.clock.now()),
            });
          }
          await refreshAfterPush(deps, {
            githubRepoId: e.repository.id,
            branch,
            defaultBranch: e.repository.default_branch,
          });
        };
      });

    case "check_run":
      return plan(CheckRunEvent, payload, (e) => {
        const run = e.check_run;
        if (!CHECK_RUN_ACTIONS.includes(e.action)) return null;
        const failed = e.action === "completed" && FAILED.includes(run.conclusion ?? "");
        return async (deps) => {
          const githubRepoId = e.repository.id;
          await refreshCanvases(deps, { githubRepoId, pullRequests: run.pull_requests });
          if (!failed) return;
          await tellCanvases(deps, {
            githubRepoId,
            pullRequests: run.pull_requests,
            kind: "check",
            payload: (pr) => ({
              source: "check_run",
              name: run.name,
              conclusion: run.conclusion,
              url: run.details_url ?? run.html_url ?? null,
              headSha: run.head_sha,
              pullRequest: pr.number,
            }),
          });
        };
      });

    case "check_suite":
      return plan(CheckSuiteEvent, payload, (e) => {
        const suite = e.check_suite;
        if (e.action !== "completed") return null;
        const failed = FAILED.includes(suite.conclusion ?? "");
        return async (deps) => {
          const githubRepoId = e.repository.id;
          await refreshCanvases(deps, { githubRepoId, pullRequests: suite.pull_requests });
          if (!failed) return;
          await tellCanvases(deps, {
            githubRepoId,
            pullRequests: suite.pull_requests,
            kind: "check",
            payload: (pr) => ({
              source: "check_suite",
              name: suite.app?.name ?? null,
              conclusion: suite.conclusion,
              headSha: suite.head_sha,
              pullRequest: pr.number,
            }),
          });
        };
      });

    case "pull_request_review":
      return plan(ReviewEvent, payload, (e) => {
        const { review } = e;
        const { user } = review;
        if (!REVIEW_ACTIONS.includes(e.action)) return null;
        const news =
          e.action === "submitted" &&
          user !== null &&
          REVIEWERS.includes(review.author_association);
        return async (deps) => {
          const githubRepoId = e.repository.id;
          await refreshCanvases(deps, { githubRepoId, pullRequests: [e.pull_request] });
          if (!news) return;
          await tellCanvases(deps, {
            githubRepoId,
            pullRequests: [e.pull_request],
            kind: "review",
            author: { githubUserId: user.id, login: user.login },
            payload: (pr: PullRequestRef) => ({
              state: review.state.toLowerCase(),
              reviewer: user.login,
              reviewerAssociation: review.author_association,
              body: (review.body ?? "").slice(0, REVIEW_BODY_CHARS),
              url: review.html_url,
              pullRequest: pr.number,
            }),
            ...(review.state.toLowerCase() === "approved" && review.id !== undefined
              ? {
                  approval: (canvasId: string, pr: PullRequestRef, reviewerId: string | null) =>
                    reviewApproved(canvasId, {
                      number: pr.number,
                      reviewId: review.id!,
                      reviewerLogin: user.login,
                      reviewerId,
                      authorLogin: e.pull_request.user?.login ?? null,
                    }),
                }
              : {}),
          });
        };
      });

    default:
      return { kind: "ignored" };
  }
}

/** The job a delivery's work is recorded as, keyed by its delivery id (`jobs/run.ts`). */
export const WEBHOOK_JOB = "github_webhook";
/** Attempts a delivery's work gets: with the retry waits, a little over two hours of them. */
export const WEBHOOK_JOB_ATTEMPTS = 8;

const WebhookJob = z.object({ event: z.string(), payload: z.unknown() });

/** What a delivery's job holds: its event and the payload `planDelivery` kept. */
export type WebhookJobPayload = z.infer<typeof WebhookJob>;

/** Run a delivery's work from its job. */
export async function runWebhookJob(deps: WebhookDeps, stored: unknown): Promise<void> {
  const { event, payload } = WebhookJob.parse(stored);
  const planned = planDelivery(event, payload);
  if (planned.kind !== "work") {
    // A payload kept by an older build that this one reads differently.
    deps.log.warn("github_webhook_job_skipped", { event, reason: planned.kind });
    return;
  }
  await planned.work(deps);
}

function plan<Schema extends z.ZodType>(
  schema: Schema,
  payload: unknown,
  decide: (event: z.output<Schema>) => Work | null,
): Plan {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return { kind: "malformed" };
  const work = decide(parsed.data);
  return work ? { kind: "work", payload: parsed.data, work } : { kind: "ignored" };
}

/**
 * Read an installation again, and make what is kept about its repos stale first: GitHub says
 * its repos changed, but not for whom.
 */
async function reconcileAndRecheck(deps: WebhookDeps, installationId: number) {
  const workspace = await getWorkspaceByInstallation(deps.db, installationId);
  if (workspace) await markRepoAccessStale(deps.db, { workspaceId: workspace.id });
  if (await reconcileInstallation(deps, installationId, { reposChanged: true })) {
    await readPeopleSoon(deps, installationId);
  }
}

/**
 * Who can reach an installation's repos changed, by GitHub's word: first `access`, the work
 * that grants or takes away what a person may do, then a read of the installation's people
 * recorded for the cron (`readPeopleSoon`), if Ponzu has a workspace for it. That read is
 * recorded even when `access` fails, and it never holds up or fails `access`: a burst of
 * deliveries is one read, and one that fails is tried again on its own.
 */
async function andThenPeople(
  deps: WebhookDeps,
  installationId: number | undefined,
  access: () => Promise<unknown>,
) {
  try {
    await access();
  } finally {
    if (
      installationId !== undefined &&
      (await getWorkspaceByInstallation(deps.db, installationId).catch(() => null))
    ) {
      await readPeopleSoon(deps, installationId);
    }
  }
}

/** Reconcile an installation only if Ponzu has a workspace for it: an event about it says no more. */
async function reconcileKnownInstallation(deps: WebhookDeps, installationId: number) {
  if (await getWorkspaceByInstallation(deps.db, installationId)) {
    await reconcileInstallation(deps, installationId);
  }
}

/**
 * A repo was renamed, moved, deleted or changed visibility or default branch. Its installation
 * is read again: the one that holds it in Ponzu (which may have just lost it) and the one the
 * event came through (which may have just gained it), if Ponzu has a workspace for it.
 */
async function reconcileRepository(
  deps: WebhookDeps,
  githubRepoId: number,
  installationId: number | undefined,
) {
  const holder = await getRepoInstallationId(deps.db, githubRepoId);
  if (installationId !== undefined && installationId !== holder) {
    await reconcileKnownInstallation(deps, installationId);
  }
  if (holder !== null) await reconcileInstallation(deps, holder);
}
