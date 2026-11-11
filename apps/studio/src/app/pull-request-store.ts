import type { PullRequestTab } from "@ponzu/client";
import type { PullRequestAction } from "@ponzu/client/query";
import { QueryObserver } from "@tanstack/react-query";
import type { LoadedDiff } from "../cloud/model.ts";
import type { NextAction } from "../cloud/pull-request.ts";
import { prActionError, rulesWant } from "./pull-request-map.ts";
import { mutate, type StorePonzu } from "./store-ponzu.ts";

/*
 * One open design's pull request: the tab as GitHub has it (read when the design opens, when
 * the head's pull request columns or the agent's turn change, and after every action), and the
 * one action the chrome offers. Ready, Auto-merge, Update branch and Merge are the person's, done
 * through the API with the commit they looked at; Create PR opens a draft from what the agent
 * committed, and when GitHub doesn't have those commits yet the API asks the design's sandbox to
 * push them and the store opens it once they land (or says why they didn't); Fix checks and
 * Resolve are the agent's, asked of it in the thread once for a commit.
 * A merge the repo's rules still hold back is offered only after the person confirms it, and goes
 * out with the commit they confirmed: a push while they decide closes the question.
 *
 * The tab is the client's `pullRequest` query, which an action's answer writes too, and a
 * file's diff its `pullRequestFile`, kept for the commit it was read at. What this keeps beside
 * them is the person's side: the action on its way, a merge waiting to be confirmed, what the
 * agent was asked.
 */

export interface PullRequestState {
  /** The last read, kept while the next is on its way and when it fails. */
  tab: PullRequestTab | null;
  /** The last read failed, or none has been made. */
  status: "loading" | "ready" | "error";
  /** The action on its way. */
  busy: NextAction | null;
  /** Merging past what the rules still want at `headSha`, waiting on the person to say so. */
  bypass: { reason: string; headSha: string } | null;
  /** The agent's action already asked of it for the head as it stands, until it moves. */
  asked: NextAction | null;
}

/** How often Create PR reads the tab while the sandbox pushes, and how long it waits in all. */
const PUSH_READ_MS = 3_000;
const PUSH_PATIENCE_MS = 3 * 60_000;

/** No pull request to show yet, and commits only the design's sandbox holds. */
function waitingOnPush(tab: PullRequestTab): boolean {
  const pr = tab.pullRequest;
  const open = pr && (pr.state === "open" || pr.state === "draft");
  return !open && tab.branch.unpushed > 0;
}

export class PullRequestStore {
  private state: PullRequestState = {
    tab: null,
    status: "loading",
    busy: null,
    bypass: null,
    asked: null,
  };
  private readonly listeners = new Set<() => void>();
  /** The head the agent was last asked about, while `asked` holds. */
  private askedAt: string | null = null;
  /**
   * Create PR is waiting on the sandbox to push the branch: since when, and the timer that reads
   * the tab again meanwhile. Once GitHub has the commits it opens the pull request.
   */
  private awaitingPush: { since: number; timer: ReturnType<typeof setInterval> } | null = null;
  private closed = false;
  /** The tab's query: read when asked to (`refresh`), and written by every action's answer. */
  private readonly query: Pick<QueryObserver, "refetch">;
  private readonly stopQuery: () => void;

  constructor(
    private readonly opts: {
      ponzu: StorePonzu;
      designId: string;
      /** Says why an action didn't happen. */
      say: (message: string) => void;
      /** Asks the agent, as a message from the person in the thread. */
      tellAgent: (text: string) => void;
    },
  ) {
    const { ponzu, designId } = opts;
    const query = new QueryObserver(ponzu.queryClient, {
      ...ponzu.queries.pullRequest(designId),
      // Read when what it shows may have moved, not whenever something watches it.
      enabled: false,
    });
    this.query = query;
    this.stopQuery = query.subscribe(({ data, isError, fetchStatus }) => {
      if (data && data !== this.state.tab) this.set({ tab: data, status: "ready" });
      else if (isError && fetchStatus === "idle") this.set({ status: "error" });
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PullRequestState => this.state;

  close(): void {
    this.closed = true;
    this.stopAwaitingPush();
    this.stopQuery();
    this.listeners.clear();
  }

  /** Reads the pull request again; a read still on its way gives way to it. */
  refresh(): void {
    void this.query.refetch();
  }

  /** A file's diff at the commit the tab shows, for its card, with where it was if renamed. */
  loadDiff = async (path: string): Promise<LoadedDiff> => {
    const { ponzu, designId } = this.opts;
    const headSha = this.state.tab?.pullRequest?.head.sha ?? null;
    const { diff, previousPath } = await ponzu.queryClient.fetchQuery(
      ponzu.queries.pullRequestFile(designId, path, headSha),
    );
    return { diff, previousPath };
  };

  run(action: NextAction): void {
    const { tab, busy } = this.state;
    if (busy || !tab) return;
    const pr = tab.pullRequest;
    switch (action) {
      case "create_pr":
        this.act(action, { kind: "open" });
        break;
      case "ready":
        this.act(action, { kind: "ready" });
        break;
      case "auto_merge":
        this.act(action, { kind: "auto_merge", on: true });
        break;
      case "update_branch":
        if (pr) this.act(action, { kind: "update_branch", headSha: pr.head.sha });
        break;
      case "merge":
        if (pr) this.act(action, { kind: "merge", headSha: pr.head.sha });
        break;
      case "blocked":
        if (pr) this.set({ bypass: { reason: rulesWant(pr), headSha: pr.head.sha } });
        break;
      case "fix_checks": {
        if (!this.ask(action)) break;
        const failing = pr?.checks.items
          .filter((check) => check.state === "failed" || check.state === "cancelled")
          .map((check) => check.name);
        this.opts.tellAgent(
          failing?.length
            ? `Fix the failing checks on the pull request (${failing.join(", ")}) and push.`
            : "Fix the failing checks on the pull request and push.",
        );
        break;
      }
      case "resolve": {
        if (!this.ask(action)) break;
        const base = tab.branch.base;
        this.opts.tellAgent(
          `The branch conflicts with ${base}. Merge ${base} in, resolve the conflicts and push.`,
        );
        break;
      }
      case "auto_merge_on":
        // Waits on GitHub: the button says so and can't be pressed.
        break;
    }
  }

  /**
   * The person said to merge past what the rules still want: GitHub decides if they may. It goes
   * out with the commit the question was asked about, so a push since is refused, not merged.
   */
  confirmBypass(): void {
    const { bypass, busy } = this.state;
    this.set({ bypass: null });
    if (!bypass || busy) return;
    this.act("blocked", { kind: "merge", headSha: bypass.headSha, bypass: true });
  }

  cancelBypass(): void {
    this.set({ bypass: null });
  }

  /** The agent's turn ended: what it was asked may be asked again, if the head didn't move. */
  agentIdle(): void {
    if (this.state.asked) this.set({ asked: null });
  }

  /** Marks `action` asked of the agent for this head; false when it already was. */
  private ask(action: NextAction): boolean {
    if (this.state.asked === action) return false;
    this.askedAt = this.state.tab?.pullRequest?.head.sha ?? null;
    this.set({ asked: action });
    return true;
  }

  /**
   * Does it through the API as the person. The answer is the whole tab, which the mutation puts
   * in the query (and so here); a refusal reads it again, since whatever turned it away (a push,
   * a teammate's merge) has moved it, and the button follows.
   */
  private act(action: NextAction, request: PullRequestAction): void {
    const { ponzu, designId } = this.opts;
    this.set({ busy: action });
    // A read on its way would answer from before the action: the action's answer is newer.
    void ponzu.queryClient.cancelQueries({
      queryKey: ponzu.queries.pullRequest(designId).queryKey,
    });
    mutate(ponzu, ponzu.mutations.pullRequestAction(), { designId, action: request }).then(
      (tab) => {
        // Create PR with commits GitHub doesn't have yet: the sandbox is pushing them first.
        if (action === "create_pr" && waitingOnPush(tab)) this.awaitPush();
        else this.set({ busy: null });
      },
      (error: unknown) => {
        this.stopAwaitingPush();
        this.set({ busy: null });
        this.opts.say(prActionError(error));
        this.refresh();
      },
    );
  }

  /** Reads the tab every few seconds until the push lands, fails, or takes too long. */
  private awaitPush(): void {
    if (this.awaitingPush || this.closed) return;
    const timer = setInterval(() => {
      if (!this.awaitingPush) return;
      if (Date.now() - this.awaitingPush.since > PUSH_PATIENCE_MS) {
        this.stopAwaitingPush();
        this.set({ busy: null });
        this.opts.say(
          "Ponzu couldn't get the branch to GitHub yet, so there's no pull request. Try Create PR again in a moment.",
        );
        return;
      }
      this.refresh();
    }, PUSH_READ_MS);
    this.awaitingPush = { since: Date.now(), timer };
  }

  private stopAwaitingPush(): void {
    if (this.awaitingPush) clearInterval(this.awaitingPush.timer);
    this.awaitingPush = null;
  }

  /** What a read says of the push Create PR is waiting on: open now, or say why it can't be. */
  private followPush(tab: PullRequestTab): void {
    if (!this.awaitingPush) return;
    const { branch } = tab;
    if (!waitingOnPush(tab)) {
      this.stopAwaitingPush();
      // GitHub has the commits: open the pull request from them, as the person asked.
      if (tab.nextAction === "create_pr") this.act("create_pr", { kind: "open" });
      else this.set({ busy: null });
      return;
    }
    if (branch.pushError) {
      this.stopAwaitingPush();
      this.set({ busy: null });
      this.opts.say(branch.pushError);
    }
  }

  private set(change: Partial<PullRequestState>): void {
    if (this.closed) return;
    const next = { ...this.state, ...change };
    this.state = change.tab === undefined ? next : { ...next, ...this.followHead(next) };
    for (const listener of this.listeners) listener();
    if (change.tab) this.followPush(change.tab);
  }

  /**
   * What a fresh read changes of the questions open on the old head. The bypass holds only while
   * the head is the one it asked about and the rules still hold the merge back, its reason kept
   * true; the agent may be asked again once the head moves.
   */
  private followHead(next: PullRequestState): Partial<PullRequestState> {
    const pr = next.tab?.pullRequest ?? null;
    const sha = pr?.head.sha ?? null;
    const change: Partial<PullRequestState> = {};
    if (next.bypass) {
      change.bypass =
        pr && sha === next.bypass.headSha && next.tab?.nextAction === "blocked"
          ? { ...next.bypass, reason: rulesWant(pr) }
          : null;
    }
    if (next.asked && sha !== this.askedAt) change.asked = null;
    return change;
  }
}
