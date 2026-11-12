import {
  appendEvent,
  type BranchCanvas,
  findCanvasByBranch,
  getUserByGithubId,
  type Json,
  listPullRequestCanvases,
} from "@ponzu/db";
import { canWrite, repoPermission } from "../auth/repo-access.ts";
import type { Deps } from "../deps/index.ts";
import type { JobDeps } from "../jobs/run.ts";
import type { NotifyTrigger } from "../notifications/kinds.ts";
import { notify } from "../notifications/notify.ts";
import { withdrawPictures } from "../pull-requests/open.ts";
import { type RefreshRequest, refreshSoon } from "../pull-requests/refresh.ts";
import { queueWake } from "../sandboxes/wake.ts";

/*
 * What GitHub says about a canvas's pull request. A canvas owns one branch of its repo
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
 * Read again, as the App, the pull requests a delivery is about, for each canvas that owns one's
 * branch, and record them (`refreshSoon`). A delivery says what was true when it was sent, and
 * GitHub sends them late and out of order, so what is recorded is GitHub's word now, never the
 * payload's.
 */
export async function refreshCanvases(
  deps: JobDeps,
  { githubRepoId, pullRequests }: { githubRepoId: number; pullRequests: PullRequestRef[] },
): Promise<void> {
  const ours = pullRequests.filter((pr) => pr.head.repo?.id === githubRepoId);
  const branches = new Map(ours.map((pr) => [pr.head.ref, pr]));
  const requests: RefreshRequest[] = [];
  for (const [branch, pullRequest] of branches) {
    const canvas = await findCanvasByBranch(deps.db, { githubRepoId, branch });
    if (canvas) requests.push({ canvasId: canvas.id, number: pullRequest.number });
  }
  await refreshSoon(deps, requests);
}

/**
 * A push. To a canvas's branch: its pull request is read again, until GitHub shows it at the
 * branch's commit and knows whether it can merge. To the branch pull requests merge into: the
 * open ones of the repo's canvases are read again (the fifty updated last), since the push may
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
    const canvasIds = await listPullRequestCanvases(deps.db, { githubRepoId, open: true });
    await refreshSoon(
      deps,
      canvasIds.map((canvasId) => ({ canvasId, number: null })),
    );
    return;
  }
  const canvas = await findCanvasByBranch(deps.db, { githubRepoId, branch });
  if (canvas) await refreshSoon(deps, [{ canvasId: canvas.id, number: null }]);
}

/**
 * A repo was made public: the pictures in its canvases' pull requests' descriptions, which only
 * a private repo's get, are taken out (`withdrawPictures`).
 */
export async function withdrawRepoPictures(deps: JobDeps, githubRepoId: number): Promise<void> {
  for (const canvasId of await listPullRequestCanvases(deps.db, { githubRepoId, open: false })) {
    try {
      await withdrawPictures(deps, canvasId);
    } catch (error) {
      // One canvas's pull request GitHub no longer has does not keep the rest's pictures up.
      deps.log.warn("pull_request_pictures_kept", { canvasId, error });
    }
  }
}

/** Someone on GitHub who wrote something a canvas's agent would read, by their GitHub id. */
export interface GithubAuthor {
  githubUserId: number;
  login: string;
}

/**
 * Tell the agent of each canvas these pull requests belong to: an event with priority `next`,
 * taken up after its current step (docs/cloud.md, "Events"). A settled canvas hears nothing.
 *
 * With an `author` (a review), a canvas hears it only when GitHub says the author can push to
 * its repo, asked through `repoPermission` like every other access question: anyone can review
 * a pull request on a public repo, and the agent reads what they wrote. The event names them
 * as a Ponzu person when they are one.
 */
export async function tellCanvases(
  deps: JobDeps,
  {
    githubRepoId,
    pullRequests,
    kind,
    payload,
    author,
    approval,
  }: {
    githubRepoId: number;
    pullRequests: PullRequestRef[];
    kind: "check" | "review";
    payload: (pullRequest: PullRequestRef) => Json;
    author?: GithubAuthor;
    /**
     * For a review that approved: its ping (`review_approved`), sent to each canvas that heard
     * the review, so only for a reviewer GitHub says can push to the repo.
     */
    approval?: (canvasId: string, pullRequest: PullRequestRef) => NotifyTrigger | null;
  },
): Promise<void> {
  const { db, log } = deps;
  const ours = pullRequests.filter((pr) => pr.head.repo?.id === githubRepoId);
  const branches = new Map(ours.map((pr) => [pr.head.ref, pr]));
  const person = author ? await getUserByGithubId(db, author.githubUserId) : null;
  for (const [branch, pullRequest] of branches) {
    const canvas = await findCanvasByBranch(db, { githubRepoId, branch });
    if (canvas?.status !== "active") continue;
    if (author && !(await canPushTo(deps, canvas, author, person?.id ?? null))) {
      log.info("canvas_event_dropped", { canvasId: canvas.id, kind, reason: "no_write_access" });
      continue;
    }
    await appendEvent(db, {
      canvasId: canvas.id,
      kind,
      priority: "next",
      payload: payload(pullRequest),
      userId: person?.id ?? null,
    });
    // `next` wakes a sleeping sandbox (docs/cloud.md, "Events").
    await queueWake(deps, canvas.id, kind);
    const ping = approval?.(canvas.id, pullRequest);
    if (ping) await notify(deps, ping);
    log.info("canvas_event_appended", { canvasId: canvas.id, kind });
  }
}

/** Whether GitHub says `author` can push to the canvas's repo. */
async function canPushTo(
  deps: Pick<Deps, "db" | "github" | "clock">,
  canvas: BranchCanvas,
  author: GithubAuthor,
  userId: string | null,
): Promise<boolean> {
  // Without the App, or while it is suspended, nobody can: there is nobody to ask.
  const permission = await repoPermission(deps, {
    user: { id: userId, githubUserId: author.githubUserId, githubLogin: author.login },
    repo: canvas.repo,
    installation: canvas,
  });
  return canWrite(permission);
}
