import {
  appendThreadItemOnce,
  countAgentPullRequestActions,
  GITHUB_KINDS,
  getPullRequestContext,
  getTurnOrigin,
  getUser,
  getUserByGithubId,
  PERSON_KINDS,
  type PullRequestContext,
  randomString,
  type User,
} from "@ponzu/db";
import type {
  AgentPullRequestAction,
  AgentPullRequestAnswer,
  PullRequestStanding,
} from "@ponzu/runner/protocol";
import { requireDesign } from "../auth/authorize.ts";
import { canWrite, repoPermission } from "../auth/repo-access.ts";
import type { Deps } from "../deps/index.ts";
import { githubUserToken } from "../github/user-token.ts";
import { ApiError } from "../http/errors.ts";
import { actAndSay, mergeHold } from "./actions.ts";
import { openPullRequest } from "./open.ts";
import { readPullRequest, recordCurrent, targetOf } from "./sync.ts";
import { type PullRequestTab, toTab } from "./view.ts";

/*
 * The design's agent driving its own pull request (docs/cloud.md, "The agent's pull request"):
 * opening it, marking it ready, bringing its branch up to date, turning on auto-merge and merging
 * it, through the very code the person's routes run (`openPullRequest`, `actAndSay`), as a
 * person. The agent holds no GitHub credential: the API acts for it, as the person it works for.
 *
 * Who that is, and what they may have it do, is decided here from the design's feed, never from
 * anything the agent says:
 *
 * - The turn's event is the one the runner names: the event whose message began the turn (a
 *   person's message or comment; a check; a review), or none for a turn an edit or Ponzu's own
 *   note began, even once a person's words come in during it. It must be one of this design's
 *   that the runner asking was handed.
 * - A person's event (message, answer, comment) is a person's turn: the agent acts as them.
 * - Any other turn (a check, a review, an edit, Ponzu's own notes, none) acts as the last person
 *   whose words went into the session, else the design's owner, and may only open, update the
 *   branch and read: never merge, mark ready or turn on auto-merge. Nor may a person's turn once
 *   a check or a review went into the session after its event, or may yet (text from GitHub is
 *   not the person), nor once anyone else's message, answer or comment did (it is no longer one
 *   person's request, and the agent would land it as the wrong one). After is the order the
 *   session took them in, not the feed's (`getTurnOrigin`).
 * - That person must still be allowed: a member of the workspace who can push to the repository
 *   (as GitHub says now), with a GitHub connection Ponzu can use.
 */

type AgentDeps = Deps;

/** What a person's turn may have the agent do that any turn may not. */
const PERSON_ONLY: ReadonlySet<AgentPullRequestAction> = new Set(["ready", "auto_merge", "merge"]);

/** How many times an hour the agent may do each to one design's pull request. */
export const AGENT_LIMITS: Record<AgentPullRequestAction, number> = {
  open: 3,
  ready: 5,
  update_branch: 6,
  auto_merge: 5,
  merge: 3,
};
const HOUR_MS = 60 * 60_000;

/** The thread notice's word for each action, in the past tense. */
const DONE: Record<AgentPullRequestAction, string> = {
  open: "opened",
  ready: "ready",
  update_branch: "updated_branch",
  auto_merge: "auto_merge",
  merge: "merged",
};

/**
 * The turn a runner's call is made in: the event the runner says began it, and the runner
 * asking, which must be the one that was handed that event.
 */
export interface Turn {
  eventId: string | null;
  runnerId: string;
}

/** Who the agent acts as in a turn, and whether the turn is a person's. */
export interface Acting {
  user: User;
  /** A person in Ponzu began this turn, and nothing from GitHub came after them. */
  personTurn: boolean;
  /** Why it is not a person's turn, for the agent to say; null when it is. */
  why: string | null;
}

/**
 * The person the agent works for in the turn `eventId` began, by the rule above, or why there is
 * none to act as. Does not check what they may do: `allowed` does.
 */
export async function actingFor(
  deps: Pick<Deps, "db">,
  designId: string,
  { eventId, runnerId }: Turn,
): Promise<Acting> {
  const origin = await getTurnOrigin(deps.db, { designId, eventId, runnerId });
  if (!origin) throw new ApiError(404, "not_found", "There is no such design.");
  const { event } = origin;
  const fromPerson =
    event !== null &&
    event.userId !== null &&
    (PERSON_KINDS as readonly string[]).includes(event.kind);
  const userId = fromPerson ? event.userId : (origin.lastPerson ?? origin.ownerId);
  const user = userId ? await getUser(deps.db, userId) : null;
  if (!user) {
    throw new ApiError(
      403,
      "forbidden",
      "No one in Ponzu can be acted for on this pull request now: the person who asked for this work no longer has an account. Ask someone in the workspace to send a message.",
    );
  }
  const why = !fromPerson
    ? event && (GITHUB_KINDS as readonly string[]).includes(event.kind)
      ? `This turn began with ${event.kind === "check" ? "a check" : "a review"} from GitHub, not a person in Ponzu.`
      : "No person in Ponzu began this turn."
    : origin.githubSince
      ? "Words from GitHub (a check or a review) came in after the person's message that began this turn."
      : origin.othersSince
        ? "Someone else spoke in the design after the person's message that began this turn, so it is no longer one person's request."
        : null;
  return { user, personTurn: why === null, why };
}

/**
 * Throws when `user` may not have the agent do this to the design's pull request: they must be a
 * member of its workspace who can push to its repository (GitHub's word, as for steering it), and
 * Ponzu must hold a GitHub connection for them that works. Every refusal is said for the agent to
 * repeat, and never as 401, which a runner takes as its own token being dead.
 */
async function allowed(deps: AgentDeps, designId: string, user: User): Promise<void> {
  const name = user.name ?? user.githubLogin;
  try {
    await requireDesign(
      { var: { deps, actor: { kind: "user", user, sessionId: "" } } },
      designId,
      "write",
    );
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      throw new ApiError(
        403,
        "forbidden",
        `${name} can't change this design's repository on GitHub now (they are no longer in the workspace, or GitHub no longer lets them push to it), so Ponzu won't act as them. Someone who can push to the repository can ask again, or use the pull request tab.`,
      );
    }
    throw error;
  }
  await asTool(name, () => githubUserToken(deps, user.id));
}

/** A person's GitHub connection that has lapsed is said as 409, never 401 (the runner's own). */
async function asTool<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError(
        409,
        "github_reauth_required",
        `${name}'s GitHub connection in Ponzu has lapsed: they need to sign in to Ponzu again before Ponzu can act as them on GitHub.`,
      );
    }
    throw error;
  }
}

/**
 * The GitHub ids, among the authors of the pull request's unresolved line comments, of those
 * GitHub says can push to the repository: the only ones whose words the agent's read quotes, as
 * only theirs reach it as a review (`tellDesigns`). A stranger on a public repository can't put
 * words into a person's turn this way. A question GitHub can't answer now drops the comment.
 */
async function pushers(
  deps: AgentDeps,
  context: PullRequestContext,
  tab: PullRequestTab,
): Promise<Set<number>> {
  const { design, repo, installationId, suspendedAt } = context;
  const can = new Set<number>();
  if (!repo || !design.repoId) return can;
  const authors = new Map<number, string>();
  for (const said of tab.pullRequest?.conversation ?? []) {
    if (said.path === null || said.resolved !== false) continue;
    if (typeof said.authorId === "number" && said.author && !said.author.bot)
      authors.set(said.authorId, said.author.login);
  }
  for (const [githubUserId, githubLogin] of authors) {
    try {
      const person = await getUserByGithubId(deps.db, githubUserId);
      const permission = await repoPermission(deps, {
        user: { id: person?.id ?? null, githubUserId, githubLogin },
        repo: { id: design.repoId, githubRepoId: repo.githubRepoId, fullName: repo.fullName },
        installation: { installationId, suspendedAt },
      });
      if (canWrite(permission)) can.add(githubUserId);
    } catch (error) {
      deps.log.warn("pull_request_agent_author_unknown", { designId: design.id, error });
    }
  }
  return can;
}

async function contextOf(deps: Pick<Deps, "db">, designId: string): Promise<PullRequestContext> {
  const context = await getPullRequestContext(deps.db, designId);
  if (!context) throw new ApiError(404, "not_found", "There is no such design.");
  return context;
}

/**
 * Where the design's pull request stands, for the agent, read now as the App, with who it would
 * act as this turn and whether it may merge. Any turn may read.
 */
export async function agentReadPullRequest(
  deps: AgentDeps,
  designId: string,
  turn: Turn,
): Promise<PullRequestStanding> {
  const context = await contextOf(deps, designId);
  const target = targetOf(context);
  if (target instanceof ApiError) throw target;
  const found = await readPullRequest(deps, target);
  await recordCurrent(deps, target.designId, found);
  const acting = await actingFor(deps, designId, turn);
  const tab = toTab(target, found.read, deps.config.githubApp.slug);
  return standing(tab, acting, await pushers(deps, context, tab));
}

/**
 * Do `action` to the design's pull request for its agent, as the person `actingFor` names, once
 * the guardrails pass: the turn may do it, the person may, and the hour's limit is not reached.
 * The merge never sets the repo's rules aside. What it did goes in the thread as the agent's own
 * line, naming the person.
 */
export async function agentActOnPullRequest(
  deps: AgentDeps,
  designId: string,
  { action, turn, headSha }: { action: AgentPullRequestAction; turn: Turn; headSha?: string },
): Promise<AgentPullRequestAnswer> {
  const acting = await actingFor(deps, designId, turn);
  if (PERSON_ONLY.has(action) && !acting.personTurn) {
    throw new ApiError(
      403,
      "turn_not_from_person",
      `${acting.why} Only a person's own message, answer or comment in Ponzu can have Claude ${ACTION_WORDS[action]}: ask them to, or they can do it in the pull request tab.`,
    );
  }
  const since = new Date(deps.clock.now() - HOUR_MS);
  const count = await countAgentPullRequestActions(deps.db, {
    designId,
    action: DONE[action],
    since,
  });
  if (count >= AGENT_LIMITS[action]) {
    throw new ApiError(
      409,
      "agent_limit",
      `Claude has already done this ${count} times to this design's pull request in the last hour, the most Ponzu allows. A person can still do it in the pull request tab.`,
    );
  }
  const { user } = acting;
  await allowed(deps, designId, user);
  const name = user.name ?? user.githubLogin;
  const context = await contextOf(deps, designId);

  let tab: PullRequestTab;
  let did: boolean;
  let pushing = false;
  if (action === "open") {
    const opened = await asTool(name, () => openPullRequest(deps, context, user));
    tab = opened.tab;
    did = opened.opened;
    pushing = opened.pushing === true;
  } else {
    const sha = headSha ?? "";
    const result = await asTool(name, () =>
      actAndSay(
        deps,
        context,
        user,
        action === "ready"
          ? { kind: "ready" }
          : action === "update_branch"
            ? { kind: "update_branch", headSha: sha }
            : action === "auto_merge"
              ? { kind: "auto_merge", enabled: true }
              : // Never past the repo's rules: the agent's merge has no bypass to send.
                { kind: "merge", headSha: sha, bypass: false },
      ),
    );
    tab = result.tab;
    did = result.did;
  }
  const pr = tab.pullRequest;
  // A merge GitHub took but doesn't show yet is not said as merged: GitHub's own line says it
  // once it does, and the agent is told to read again.
  if (did && pr && (action !== "merge" || pr.state === "merged")) {
    await appendThreadItemOnce(deps.db, {
      // Not a runner's shape (`ti_` and sixteen letters and digits): no sandbox can write it.
      id: `ti_pra-${randomString(16)}`,
      designId,
      kind: "notice",
      payload: {
        type: "pull_request_agent",
        action: DONE[action],
        number: pr.number,
        url: pr.url,
        title: pr.title,
        as: { id: user.id, name, login: user.githubLogin },
        // When, by the API's clock: what the hour's limits count by.
        at: new Date(deps.clock.now()).toISOString(),
      },
    });
    deps.log.info("pull_request_agent", { designId, action, number: pr.number, as: user.id });
  }
  return { did, pushing, ...standing(tab, acting, await pushers(deps, context, tab)) };
}

const ACTION_WORDS: Record<AgentPullRequestAction, string> = {
  open: "open the pull request",
  ready: "mark the pull request ready for review",
  update_branch: "update the branch",
  auto_merge: "turn on auto-merge",
  merge: "merge the pull request",
};

/** The pull request as the agent is told it: what the tab shows that it can act on. */
function standing(
  tab: PullRequestTab,
  acting: Acting,
  canPush: ReadonlySet<number>,
): PullRequestStanding {
  const p = tab.pullRequest;
  return {
    branch: {
      name: tab.branch.name,
      base: tab.branch.base,
      exists: tab.branch.exists,
      aheadBy: tab.branch.aheadBy,
      behindBy: tab.branch.behindBy,
    },
    pullRequest: p && {
      number: p.number,
      url: p.url,
      title: p.title,
      state: p.state,
      headSha: p.head.sha,
      author: p.author?.login ?? null,
      mergedBy: p.mergedBy?.login ?? null,
      mergeable: p.mergeable,
      mergeState: p.mergeState,
      reviewDecision: p.reviewDecision,
      autoMerge: p.autoMerge ? { enabledBy: p.autoMerge.enabledBy?.login ?? null } : null,
      checks: {
        state: p.checks.state,
        complete: p.checks.complete,
        items: p.checks.items.map((check) => ({
          name: check.name,
          state: check.state,
          required: check.required,
          url: check.url,
        })),
      },
      reviews: p.reviews.map((review) => ({
        author: review.author?.login ?? null,
        state: review.state,
      })),
      unresolved: p.conversation
        .filter(
          (said) =>
            said.path !== null &&
            said.resolved === false &&
            typeof said.authorId === "number" &&
            canPush.has(said.authorId),
        )
        .map((said) => ({
          author: said.author?.login ?? null,
          path: said.path!,
          line: said.line,
          body: said.body,
        })),
      mergeHold: mergeHold(p),
    },
    mergeMethod: tab.mergeMethod,
    autoMergeAllowed: tab.autoMergeAllowed,
    nextAction: tab.nextAction,
    actingAs: { name: acting.user.name ?? acting.user.githubLogin, login: acting.user.githubLogin },
    personTurn: acting.personTurn,
    notPersonTurn: acting.why,
  };
}
