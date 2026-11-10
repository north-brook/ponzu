import { createHmac, timingSafeEqual } from "node:crypto";
import { getRepoInstallationId, getUserByGithubId, getWorkspaceByInstallation } from "@ponzu/db";
import { z } from "zod";
import type { Deps } from "../deps/index.ts";
import { reconcileInstallation } from "./installations.ts";
import { type PullRequestRef, recordPullRequestEvent, tellDesigns } from "./pull-requests.ts";
import { forgetRevokedAuthorization } from "./revoked.ts";
import { resyncGithubUser } from "./sync.ts";

/*
 * GitHub's webhooks: which deliveries mean something to Ponzu, and the work each one starts.
 *
 * A delivery is a signal, not a record. GitHub sends one late, twice, or after a later one, so
 * nothing here writes what a payload says about an installation or its repos: it asks GitHub
 * for the installation as it is now (`reconcileInstallation`) or syncs the person it names. A
 * pull request is the exception, recorded from its payload, and that keeps only the newest
 * word. Every handler can run again with the same delivery and change nothing more.
 *
 * Only the fields used are read; the schemas below are that list.
 */

/** Whether `header` is GitHub's signature of exactly these bytes, compared in constant time. */
export function verifySignature(secret: string, body: Uint8Array, header: string | undefined) {
  const signature = /^sha256=([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

export type WebhookDeps = Pick<Deps, "db" | "clock" | "vault" | "github" | "log">;
type Work = (deps: WebhookDeps) => Promise<void>;

export type Plan =
  | { kind: "work"; work: Work }
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
const MemberEvent = z.object({ action: z.string(), member: Id });
const OrganizationEvent = z.object({
  action: z.string(),
  membership: z.object({ user: Id.nullable() }).optional(),
  installation: Id.optional(),
});
const AuthorizationEvent = z.object({ action: z.string(), sender: Id });
const PullRequestEvent = z.object({
  action: z.string(),
  repository: Id,
  pull_request: PullRequest.extend({
    state: z.string(),
    draft: z.boolean(),
    merged: z.boolean().nullish(),
    updated_at: z.iso.datetime({ offset: true }),
  }),
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
    state: z.string(),
    body: z.string().nullable(),
    html_url: z.string(),
    user: z.object({ login: z.string() }).nullable(),
  }),
  pull_request: PullRequest,
});

const INSTALLATION_ACTIONS = [
  "created",
  "deleted",
  "suspend",
  "unsuspend",
  "new_permissions_accepted",
];
const REPOSITORY_ACTIONS = ["renamed", "transferred", "deleted", "privatized", "publicized"];
const PULL_REQUEST_ACTIONS = [
  "opened",
  "closed",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
];
/** Check conclusions that are something the agent should hear about. */
const FAILED = ["failure", "timed_out", "action_required", "startup_failure"];
/** The most of a review's text a design's feed keeps. */
const REVIEW_BODY_CHARS = 4_000;

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
          if (!workspace || e.action !== "created") return;
          // Whoever installed it, and whoever asked an owner to, can reach it now.
          for (const person of new Set([e.sender.id, e.requester?.id])) {
            if (person !== undefined) await resyncGithubUser(deps, person);
          }
        };
      });

    case "installation_repositories":
    case "installation_target":
      return plan(
        InstallationScoped,
        payload,
        (e) => (deps) => reconcileInstallation(deps, e.installation.id).then(() => {}),
      );

    case "repository":
      return plan(RepositoryEvent, payload, (e) => {
        const defaultBranchChanged = e.action === "edited" && e.changes?.default_branch;
        if (!REPOSITORY_ACTIONS.includes(e.action) && !defaultBranchChanged) return null;
        return (deps) => reconcileRepository(deps, e.repository.id, e.installation?.id);
      });

    case "member":
    case "membership":
      // A collaborator added to or removed from a repo; someone added to or removed from a team.
      return plan(MemberEvent, payload, (e) => (deps) => resyncGithubUser(deps, e.member.id));

    case "organization":
      return plan(OrganizationEvent, payload, (e) => {
        const person = e.membership?.user?.id;
        if ((e.action === "member_added" || e.action === "member_removed") && person) {
          return (deps) => resyncGithubUser(deps, person);
        }
        const installationId = e.installation?.id;
        if (e.action === "renamed" && installationId) {
          return (deps) => reconcileKnownInstallation(deps, installationId);
        }
        return null;
      });

    case "github_app_authorization":
      return plan(AuthorizationEvent, payload, (e) => {
        if (e.action !== "revoked") return null;
        return (deps) => forgetRevokedAuthorization(deps, e.sender.id);
      });

    case "pull_request":
      return plan(PullRequestEvent, payload, (e) => {
        if (!PULL_REQUEST_ACTIONS.includes(e.action)) return null;
        const pr = e.pull_request;
        return (deps) =>
          recordPullRequestEvent(deps, {
            githubRepoId: e.repository.id,
            pullRequest: { ...pr, updatedAt: new Date(pr.updated_at) },
          });
      });

    case "check_run":
      return plan(CheckRunEvent, payload, (e) => {
        const run = e.check_run;
        if (e.action !== "completed" || !FAILED.includes(run.conclusion ?? "")) return null;
        return (deps) =>
          tellDesigns(deps, {
            githubRepoId: e.repository.id,
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
      });

    case "check_suite":
      return plan(CheckSuiteEvent, payload, (e) => {
        const suite = e.check_suite;
        if (e.action !== "completed" || !FAILED.includes(suite.conclusion ?? "")) return null;
        return (deps) =>
          tellDesigns(deps, {
            githubRepoId: e.repository.id,
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
      });

    case "pull_request_review":
      return plan(ReviewEvent, payload, (e) => {
        if (e.action !== "submitted") return null;
        const { review } = e;
        return (deps) =>
          tellDesigns(deps, {
            githubRepoId: e.repository.id,
            pullRequests: [e.pull_request],
            kind: "review",
            payload: (pr: PullRequestRef) => ({
              state: review.state.toLowerCase(),
              reviewer: review.user?.login ?? null,
              body: (review.body ?? "").slice(0, REVIEW_BODY_CHARS),
              url: review.html_url,
              pullRequest: pr.number,
            }),
          });
      });

    default:
      return { kind: "ignored" };
  }
}

function plan<Schema extends z.ZodType>(
  schema: Schema,
  payload: unknown,
  decide: (event: z.output<Schema>) => Work | null,
): Plan {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return { kind: "malformed" };
  const work = decide(parsed.data);
  return work ? { kind: "work", work } : { kind: "ignored" };
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
