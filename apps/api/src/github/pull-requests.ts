import {
  appendEvent,
  type BranchCanvas,
  findCanvasByBranch,
  findLinkingCanvases,
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
 * branch, in that repo. One from a fork never is, whatever its branch is called. A canvas may
 * also link pull requests (docs/cloud.md, "Linked pull requests"): those are found by their repo
 * and number, whatever branch or fork they are from. They are read again, and a failed check or
 * a review on one is told to the canvas's agent as on its own, saying which pull request it is.
 */

/** A pull request as a webhook names it. */
export interface PullRequestRef {
  number: number;
  /** The branch it merges from, and the repo that branch is in (null once a fork is deleted). */
  head: { ref: string; repo: { id: number } | null };
}

/**
 * Read again, as the App, the pull requests a delivery is about, for each canvas that owns one's
 * branch or links it, and record them (`refreshSoon`). A delivery says what was true when it was sent, and
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
  const numbers = [...new Set(pullRequests.map((pr) => pr.number))];
  for (const link of await findLinkingCanvases(deps.db, { githubRepoId, numbers })) {
    requests.push({ canvasId: link.canvasId, repoId: link.repoId, number: link.number });
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
 * Tell the agent of each canvas these pull requests belong to, or that links one of them: an
 * event with priority `next`, taken up after its current step (docs/cloud.md, "Events"). A
 * settled canvas hears nothing. A linked pull request's event says it is one (`linked`, with its
 * repo): the agent didn't open it and can't push to it.
 *
 * With an `author` (a review), a canvas hears it only when GitHub says the author can push to
 * the pull request's repo, asked through `repoPermission` like every other access question:
 * anyone can review a pull request on a public repo, and the agent reads what they wrote. The
 * event names them as a Ponzu person when they are one.
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
     * For a review that approved its canvas's own pull request: its ping (`review_approved`),
     * sent to each canvas that heard the review, so only for a reviewer GitHub says can push to
     * the repo. A linked pull request's approval pings nobody: it isn't the canvas's to merge.
     */
    approval?: (
      canvasId: string,
      pullRequest: PullRequestRef,
      /** The reviewer as a Ponzu person, by their GitHub user id, when they are one. */
      reviewerId: string | null,
    ) => NotifyTrigger | null;
  },
): Promise<void> {
  const { db, log } = deps;
  const person = author ? await getUserByGithubId(db, author.githubUserId) : null;
  const told = new Set<string>();
  const tell = async (
    canvas: TellTarget,
    pullRequest: PullRequestRef,
    linked: { repository: string } | null,
  ) => {
    const key = `${canvas.id}#${pullRequest.number}`;
    if (canvas.status !== "active" || told.has(key)) return;
    told.add(key);
    if (author && !(await canPushTo(deps, canvas, author, person?.id ?? null))) {
      log.info("canvas_event_dropped", { canvasId: canvas.id, kind, reason: "no_write_access" });
      return;
    }
    await appendEvent(db, {
      canvasId: canvas.id,
      kind,
      priority: "next",
      payload: linked ? { ...payload(pullRequest), linked } : payload(pullRequest),
      userId: person?.id ?? null,
    });
    // `next` wakes a sleeping sandbox (docs/cloud.md, "Events").
    await queueWake(deps, canvas.id, kind);
    const ping = linked ? null : approval?.(canvas.id, pullRequest, person?.id ?? null);
    if (ping) await notify(deps, ping);
    log.info("canvas_event_appended", { canvasId: canvas.id, kind, linked: linked !== null });
  };

  // The canvases whose branch it is: never one from a fork, whatever its branch is called.
  const ours = pullRequests.filter((pr) => pr.head.repo?.id === githubRepoId);
  const branches = new Map(ours.map((pr) => [pr.head.ref, pr]));
  for (const [branch, pullRequest] of branches) {
    const canvas = await findCanvasByBranch(db, { githubRepoId, branch });
    if (canvas) await tell(canvas, pullRequest, null);
  }
  // The canvases that link it, from whatever branch or fork.
  const byNumber = new Map(pullRequests.map((pr) => [pr.number, pr]));
  const numbers = [...byNumber.keys()];
  for (const link of await findLinkingCanvases(db, { githubRepoId, numbers })) {
    const target: TellTarget = {
      id: link.canvasId,
      status: link.canvasStatus,
      repo: { id: link.repoId, ...link.repo },
      installationId: link.installationId,
      suspendedAt: link.suspendedAt,
    };
    await tell(target, byNumber.get(link.number)!, {
      repository: link.repo.fullName,
    });
  }
}

/** A canvas to tell, with the repo of the pull request it hears about and who can read it. */
type TellTarget = Pick<BranchCanvas, "id" | "status" | "repo" | "installationId" | "suspendedAt">;

/** Whether GitHub says `author` can push to the repo of the pull request `canvas` hears about. */
async function canPushTo(
  deps: Pick<Deps, "db" | "github" | "clock" | "vault" | "log">,
  canvas: TellTarget,
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
