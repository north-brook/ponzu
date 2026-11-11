import {
  appendEvent,
  type BranchDesign,
  findDesignByBranch,
  getUserByGithubId,
  type Json,
  listPullRequestDesigns,
} from "@ponzu/db";
import { canWrite, repoPermission } from "../auth/repo-access.ts";
import type { Deps } from "../deps/index.ts";
import type { JobDeps } from "../jobs/run.ts";
import { withdrawPictures } from "../pull-requests/open.ts";
import { type RefreshRequest, refreshSoon } from "../pull-requests/refresh.ts";
import { queueWake } from "../sandboxes/wake.ts";

/*
 * What GitHub says about a design's pull request. A design owns one branch of its repo
 * (`pz/<topic>`), and a pull request, check or review belongs to it when it is about that
 * branch, in that repo. One from a fork never is, whatever its branch is called.
 */

/** A pull request as a webhook names it. */
export interface PullRequestRef {
  number: number;
  /** The branch it merges from, and the repo that branch is in (null once a fork is deleted). */
  head: { ref: string; repo: { id: number } | null };
}

/**
 * Read again, as the App, the pull requests a delivery is about, for each design that owns one's
 * branch, and record them (`refreshSoon`). A delivery says what was true when it was sent, and
 * GitHub sends them late and out of order, so what is recorded is GitHub's word now, never the
 * payload's.
 */
export async function refreshDesigns(
  deps: JobDeps,
  { githubRepoId, pullRequests }: { githubRepoId: number; pullRequests: PullRequestRef[] },
): Promise<void> {
  const ours = pullRequests.filter((pr) => pr.head.repo?.id === githubRepoId);
  const branches = new Map(ours.map((pr) => [pr.head.ref, pr]));
  const requests: RefreshRequest[] = [];
  for (const [branch, pullRequest] of branches) {
    const design = await findDesignByBranch(deps.db, { githubRepoId, branch });
    if (design) requests.push({ designId: design.id, number: pullRequest.number });
  }
  await refreshSoon(deps, requests);
}

/**
 * A push. To a design's branch: its pull request is read again, until GitHub shows it at the
 * branch's commit and knows whether it can merge. To the branch pull requests merge into: the
 * open ones of the repo's designs are read again (the fifty updated last), since the push may
 * have given them conflicts.
 */
export async function refreshAfterPush(
  deps: JobDeps,
  {
    githubRepoId,
    branch,
    defaultBranch,
  }: { githubRepoId: number; branch: string; defaultBranch: string },
): Promise<void> {
  if (branch === defaultBranch) {
    const designIds = await listPullRequestDesigns(deps.db, { githubRepoId, open: true });
    await refreshSoon(
      deps,
      designIds.map((designId) => ({ designId, number: null })),
    );
    return;
  }
  const design = await findDesignByBranch(deps.db, { githubRepoId, branch });
  if (design) await refreshSoon(deps, [{ designId: design.id, number: null }]);
}

/**
 * A repo was made public: the pictures in its designs' pull requests' descriptions, which only
 * a private repo's get, are taken out (`withdrawPictures`).
 */
export async function withdrawRepoPictures(deps: JobDeps, githubRepoId: number): Promise<void> {
  for (const designId of await listPullRequestDesigns(deps.db, { githubRepoId, open: false })) {
    try {
      await withdrawPictures(deps, designId);
    } catch (error) {
      // One design's pull request GitHub no longer has does not keep the rest's pictures up.
      deps.log.warn("pull_request_pictures_kept", { designId, error });
    }
  }
}

/** Someone on GitHub who wrote something a design's agent would read, by their GitHub id. */
export interface GithubAuthor {
  githubUserId: number;
  login: string;
}

/**
 * Tell the agent of each design these pull requests belong to: an event with priority `next`,
 * taken up after its current step (docs/cloud.md, "Events"). A settled design hears nothing.
 *
 * With an `author` (a review), a design hears it only when GitHub says the author can push to
 * its repo, asked through `repoPermission` like every other access question: anyone can review
 * a pull request on a public repo, and the agent reads what they wrote. The event names them
 * as a Ponzu person when they are one.
 */
export async function tellDesigns(
  deps: Pick<Deps, "db" | "github" | "clock" | "log">,
  {
    githubRepoId,
    pullRequests,
    kind,
    payload,
    author,
  }: {
    githubRepoId: number;
    pullRequests: PullRequestRef[];
    kind: "check" | "review";
    payload: (pullRequest: PullRequestRef) => Json;
    author?: GithubAuthor;
  },
): Promise<void> {
  const { db, log } = deps;
  const ours = pullRequests.filter((pr) => pr.head.repo?.id === githubRepoId);
  const branches = new Map(ours.map((pr) => [pr.head.ref, pr]));
  const person = author ? await getUserByGithubId(db, author.githubUserId) : null;
  for (const [branch, pullRequest] of branches) {
    const design = await findDesignByBranch(db, { githubRepoId, branch });
    if (design?.status !== "active") continue;
    if (author && !(await canPushTo(deps, design, author, person?.id ?? null))) {
      log.info("design_event_dropped", { designId: design.id, kind, reason: "no_write_access" });
      continue;
    }
    await appendEvent(db, {
      designId: design.id,
      kind,
      priority: "next",
      payload: payload(pullRequest),
      userId: person?.id ?? null,
    });
    // `next` wakes a sleeping sandbox (docs/cloud.md, "Events").
    await queueWake(deps, design.id, kind);
    log.info("design_event_appended", { designId: design.id, kind });
  }
}

/** Whether GitHub says `author` can push to the design's repo. */
async function canPushTo(
  deps: Pick<Deps, "db" | "github" | "clock">,
  design: BranchDesign,
  author: GithubAuthor,
  userId: string | null,
): Promise<boolean> {
  // Without the App, or while it is suspended, nobody can: there is nobody to ask.
  const permission = await repoPermission(deps, {
    user: { id: userId, githubUserId: author.githubUserId, githubLogin: author.login },
    repo: design.repo,
    installation: design,
  });
  return canWrite(permission);
}
