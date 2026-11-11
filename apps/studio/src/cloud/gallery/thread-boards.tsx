/* The compositions of the thread rail, needs you and the pull request tab (compositions.ts). */
import type { ReactNode } from "react";
import type { AgentActivity, DesignSummary } from "../model.ts";
import { DesignHarness } from "./design-harness.tsx";
import * as f from "./fixtures.ts";
import { LiveTurnRail } from "./live-turn.tsx";
import * as t from "./thread-fixtures.ts";

export const WORKING: AgentActivity = { state: "working", status: null };
const WAITING: AgentActivity = { state: "needs_you", status: null };
const IDLE: AgentActivity = { state: "idle", status: null };

const QUIETER = "dsn_quieter";
const quieter = (designs: DesignSummary[]) => designs.find((d) => d.id === QUIETER)!;
/** Mac boards 2 and 3: the open design waits on two questions. */
const asking = f.soloDesigns.map((d) => (d.id === QUIETER ? { ...d, needsYou: 2 } : d));
const long = t.longThread();

/** An open design whose rail shows one of the turn fixtures. */
const turnBoard = (thread: ReturnType<typeof t.said>[], agent: AgentActivity) => () => (
  <DesignHarness
    designs={f.soloDesigns}
    design={quieter(f.soloDesigns)}
    contributors={f.justYou}
    thread={thread}
    agent={agent}
  />
);
const working = (status: string): AgentActivity => ({ state: "working", status });

/** A turn running, finished, stopped, failed, asking; and a thread an older runner wrote. */
export const TURN_BOARDS: Record<string, () => ReactNode> = {
  "turn-running": turnBoard([...t.askedTurn, ...t.runningTurn], working('Drawing "5 · Schedule"')),
  "turn-running-thinking": turnBoard([...t.askedTurn, ...t.runningTurn], working("Thinking")),
  "turn-running-command": turnBoard(
    [...t.askedTurn, ...t.runningTurn],
    working("Running the dev server"),
  ),
  "turn-completed": turnBoard([...t.stoppedTurn, ...t.askedTurn, ...t.completedTurn], IDLE),
  "turn-completed-open": turnBoard([...t.stoppedTurn, ...t.askedTurn, ...t.completedTurn], IDLE),
  "turn-stopped": turnBoard(t.stoppedTurn, IDLE),
  "turn-failed": turnBoard(t.failedTurn, IDLE),
  "turn-asked": turnBoard(t.askedTurn, IDLE),
  "turn-old-runner": turnBoard(t.oldFormatThread, IDLE),
};

export const THREAD_BOARDS: Record<string, () => ReactNode> = {
  ...TURN_BOARDS,
  // Not a composition: a turn the browser tests play through, frame by frame.
  "turn-live": () => <LiveTurnRail />,
  "needs-you-a-question": () => (
    <DesignHarness
      designs={asking}
      design={quieter(asking)}
      contributors={f.justYou}
      thread={t.askingThread}
      agent={WAITING}
      asks={t.boardAsks}
    />
  ),
  "pull-request-tab": () => (
    <DesignHarness
      designs={asking}
      design={quieter(asking)}
      contributors={null}
      thread={t.askingThread}
      agent={WAITING}
      asks={t.boardAsks}
      pullRequest={{ kind: "ready", pr: t.pullRequest }}
      tab="pull-request"
    />
  ),
  "together-on-a-design": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={f.contributors}
      thread={t.teamThread}
      agent={t.teamAgent}
    />
  ),
  "crowded-chrome": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={[...f.contributors, { person: f.alex, here: true, lastHereAt: null }]}
      thread={t.teamThread}
      agent={t.teamAgent}
      action="update_branch"
    />
  ),
  "crowded-chrome-closed": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={[...f.contributors, { person: f.alex, here: true, lastHereAt: null }]}
      thread={t.teamThread}
      agent={t.teamAgent}
      action="update_branch"
      rail={false}
    />
  ),
  // The same at the smallest window: the page tabs give way to the cluster.
  "crowded-chrome-min-window": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={[...f.contributors, { person: f.alex, here: true, lastHereAt: null }]}
      thread={t.teamThread}
      agent={WORKING}
      action="update_branch"
    />
  ),
  "long-thread": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={f.justYou}
      thread={long.slice(-200)}
      olderThread={long.slice(0, -200)}
      agent={WORKING}
    />
  ),
  "thread-loading": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={f.justYou}
      thread={null}
      agent={IDLE}
    />
  ),
  "thread-every-kind": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={f.contributors}
      thread={t.everyKind}
      agent={WORKING}
    />
  ),
  "thread-read-only": () => (
    <DesignHarness
      designs={f.teamDesigns}
      design={quieter(f.teamDesigns)}
      contributors={f.contributors}
      thread={t.teamThread}
      agent={t.teamAgent}
      gate={{ kind: "read_only", repo: f.fernwood }}
    />
  ),
  "pull-request-busy": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={{ ...quieter(f.soloDesigns), pullRequest: { ...f.pr412, state: "draft" } }}
      contributors={null}
      thread={t.heroThread}
      agent={t.heroAgent}
      pullRequest={{ kind: "ready", pr: t.busyPullRequest }}
      tab="pull-request"
    />
  ),
  "pull-request-merged": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={{ ...quieter(f.soloDesigns), pullRequest: { ...f.pr412, state: "merged" } }}
      contributors={null}
      thread={t.heroThread}
      agent={IDLE}
      pullRequest={{
        kind: "ready",
        pr: { ...t.pullRequest, state: "merged", endedAt: t.pullRequest.reviews[0]!.at },
      }}
      tab="pull-request"
    />
  ),
  "pull-request-one-file": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={{ ...quieter(f.soloDesigns), pullRequest: { ...f.pr412, state: "merged" } }}
      contributors={null}
      thread={t.heroThread}
      agent={IDLE}
      pullRequest={{
        kind: "ready",
        pr: {
          ...t.pullRequest,
          state: "merged",
          head: "pz/320x200-card-with-the-word-hello",
          endedAt: t.pullRequest.reviews[0]!.at,
          checks: [],
          files: t.pullRequest.files.slice(0, 1),
          filesTotal: 1,
          additions: t.pullRequest.files[0]!.additions,
          deletions: t.pullRequest.files[0]!.deletions,
        },
      }}
      tab="pull-request"
    />
  ),
  "pull-request-rail-closed": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={null}
      thread={t.heroThread}
      agent={IDLE}
      pullRequest={{ kind: "ready", pr: t.pullRequest }}
      tab="pull-request"
      rail={false}
    />
  ),
  "pull-request-min-window": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={null}
      thread={t.heroThread}
      agent={IDLE}
      pullRequest={{
        kind: "ready",
        pr: {
          ...t.busyPullRequest,
          title:
            "Quieter hero, editorial take: the paragraph goes, the photo carries it, and the headline moves to Instrument Serif",
          head: "pz/quieter-hero-editorial-take-with-instrument-serif",
        },
      }}
      tab="pull-request"
    />
  ),
  "pull-request-wide": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={null}
      thread={t.heroThread}
      agent={IDLE}
      pullRequest={{ kind: "ready", pr: t.pullRequest }}
      tab="pull-request"
      sidebar="closed"
    />
  ),
  "pull-request-loading": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={null}
      thread={t.heroThread}
      agent={t.heroAgent}
      pullRequest={{ kind: "loading", summary: f.pr412 }}
      tab="pull-request"
    />
  ),
  "pull-request-error": () => (
    <DesignHarness
      designs={f.soloDesigns}
      design={quieter(f.soloDesigns)}
      contributors={null}
      thread={t.heroThread}
      agent={t.heroAgent}
      pullRequest={{ kind: "error", summary: f.pr412 }}
      tab="pull-request"
    />
  ),
};
