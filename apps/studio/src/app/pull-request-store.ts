import type { Api, PullRequestTab } from "@ponzu/client";
import type { LoadedDiff } from "../cloud/model.ts";
import type { NextAction } from "../cloud/pull-request.ts";
import { prActionError, rulesWant } from "./pull-request-map.ts";

/*
 * One open design's pull request: the tab as GitHub has it (read when the design opens, when
 * the head's pull request columns or the agent's turn change, and after every action), and the
 * one action the chrome offers. Ready, Auto-merge, Update branch and Merge are the person's, done
 * through the API with the commit they looked at; Create PR opens a draft from what the agent
 * pushed; Fix checks and Resolve are the agent's, asked of it in the thread once for a commit.
 * A merge the repo's rules still hold back is offered only after the person confirms it, and goes
 * out with the commit they confirmed: a push while they decide closes the question.
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
  /** Only the latest read is taken. */
  private reads = 0;
  private closed = false;

  constructor(
    private readonly opts: {
      api: Pick<Api, "designs">;
      designId: string;
      /** Says why an action didn't happen. */
      say: (message: string) => void;
      /** Asks the agent, as a message from the person in the thread. */
      tellAgent: (text: string) => void;
    },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PullRequestState => this.state;

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  /** Reads the pull request again. */
  refresh(): void {
    const mine = ++this.reads;
    this.opts.api.designs.pullRequest.get(this.opts.designId).then(
      (tab) => mine === this.reads && this.set({ tab, status: "ready" }),
      () => mine === this.reads && this.set({ status: "error" }),
    );
  }

  /** A file's diff, for its card, with where it was if it was renamed. */
  loadDiff = async (path: string): Promise<LoadedDiff> => {
    const { diff, previousPath } = await this.opts.api.designs.pullRequest.file(
      this.opts.designId,
      path,
    );
    return { diff, previousPath };
  };

  run(action: NextAction): void {
    const { tab, busy } = this.state;
    if (busy || !tab) return;
    const pr = tab.pullRequest;
    const { pullRequest } = this.opts.api.designs;
    const id = this.opts.designId;
    switch (action) {
      case "create_pr":
        this.act(action, () => pullRequest.open(id));
        break;
      case "ready":
        this.act(action, () => pullRequest.ready(id));
        break;
      case "auto_merge":
        this.act(action, () => pullRequest.autoMerge(id, true));
        break;
      case "update_branch":
        if (pr) this.act(action, () => pullRequest.updateBranch(id, { headSha: pr.head.sha }));
        break;
      case "merge":
        if (pr) this.act(action, () => pullRequest.merge(id, { headSha: pr.head.sha }));
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
    this.act("blocked", () =>
      this.opts.api.designs.pullRequest.merge(this.opts.designId, {
        headSha: bypass.headSha,
        bypass: true,
      }),
    );
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

  private act(action: NextAction, call: () => Promise<PullRequestTab>): void {
    this.set({ busy: action });
    const mine = ++this.reads;
    call().then(
      (tab) => {
        this.set({ busy: null, ...(mine === this.reads ? { tab, status: "ready" } : {}) });
      },
      (error: unknown) => {
        this.set({ busy: null });
        this.opts.say(prActionError(error));
        // Whatever moved under it (a push, a teammate's merge), the button follows.
        this.refresh();
      },
    );
  }

  private set(change: Partial<PullRequestState>): void {
    if (this.closed) return;
    const next = { ...this.state, ...change };
    this.state = change.tab === undefined ? next : { ...next, ...this.followHead(next) };
    for (const listener of this.listeners) listener();
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
