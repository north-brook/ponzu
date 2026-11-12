/* The compositions of the thread rail, needs you and the pull request tab (compositions.ts). */
import type { ReactNode } from "react";
import type { AgentActivity, CanvasSummary } from "../model.ts";
import { teamHeroBoards } from "./canvas-fixtures.ts";
import { CanvasHarness } from "./canvas-harness.tsx";
import * as f from "./fixtures.ts";
import { LiveTurnRail } from "./live-turn.tsx";
import * as t from "./thread-fixtures.ts";

export const WORKING: AgentActivity = { state: "working", status: null };
const WAITING: AgentActivity = { state: "needs_you", status: null };
const IDLE: AgentActivity = { state: "idle", status: null };

const QUIETER = "cnv_quieter";
const quieter = (canvases: CanvasSummary[]) => canvases.find((d) => d.id === QUIETER)!;
/** Mac boards 2 and 3: the open canvas waits on two questions. */
const asking = f.soloCanvases.map((d) => (d.id === QUIETER ? { ...d, needsYou: 2 } : d));
const long = t.longThread();

/** An open canvas whose rail shows one of the turn fixtures. */
const turnBoard = (thread: ReturnType<typeof t.said>[], agent: AgentActivity) => () => (
  <CanvasHarness
    canvases={f.soloCanvases}
    canvas={quieter(f.soloCanvases)}
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
  "turn-stopped": turnBoard(t.stoppedTurn, IDLE),
  "turn-failed": turnBoard(t.failedTurn, IDLE),
  "turn-asked": turnBoard(t.askedTurn, IDLE),
  "turn-old-runner": turnBoard(t.oldFormatThread, IDLE),
};

export const THREAD_BOARDS: Record<string, () => ReactNode> = {
  ...TURN_BOARDS,
  // Not a composition: a turn the browser tests play through, frame by frame.
  "turn-live": () => <LiveTurnRail />,
  // The same, under sixty earlier lines: for reading up while it ends.
  "turn-live-long": () => <LiveTurnRail earlier />,
  "needs-you-a-question": () => (
    <CanvasHarness
      canvases={asking}
      canvas={quieter(asking)}
      contributors={f.justYou}
      thread={t.askingThread}
      agent={WAITING}
      asks={t.boardAsks}
    />
  ),
  "pull-request-tab": () => (
    <CanvasHarness
      canvases={asking}
      canvas={quieter(asking)}
      contributors={null}
      thread={t.askingThread}
      agent={WAITING}
      asks={t.boardAsks}
      pullRequest={{ kind: "ready", pr: t.pullRequest }}
      tab="pull-request"
    />
  ),
  "together-on-a-canvas": () => (
    <CanvasHarness
      canvases={f.teamCanvases}
      canvas={quieter(f.teamCanvases)}
      contributors={f.contributors}
      thread={t.teamThread}
      agent={t.teamAgent}
      boards={teamHeroBoards}
    />
  ),
  "crowded-chrome": () => (
    <CanvasHarness
      canvases={f.teamCanvases}
      canvas={quieter(f.teamCanvases)}
      contributors={[...f.contributors, { person: f.alex, here: true, lastHereAt: null }]}
      thread={t.teamThread}
      agent={t.teamAgent}
      action="update_branch"
    />
  ),
  "crowded-chrome-closed": () => (
    <CanvasHarness
      canvases={f.teamCanvases}
      canvas={quieter(f.teamCanvases)}
      contributors={[...f.contributors, { person: f.alex, here: true, lastHereAt: null }]}
      thread={t.teamThread}
      agent={t.teamAgent}
      action="update_branch"
      rail={false}
    />
  ),
  // The same at the smallest window: the page tabs give way to the cluster.
  "crowded-chrome-min-window": () => (
    <CanvasHarness
      canvases={f.teamCanvases}
      canvas={quieter(f.teamCanvases)}
      contributors={[...f.contributors, { person: f.alex, here: true, lastHereAt: null }]}
      thread={t.teamThread}
      agent={WORKING}
      action="update_branch"
    />
  ),
  "long-thread": () => (
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={quieter(f.soloCanvases)}
      contributors={f.justYou}
      thread={long.slice(-200)}
      olderThread={long.slice(0, -200)}
      agent={WORKING}
    />
  ),
  "thread-loading": () => (
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={quieter(f.soloCanvases)}
      contributors={f.justYou}
      thread={null}
      agent={IDLE}
    />
  ),
  "thread-every-kind": () => (
    <CanvasHarness
      canvases={f.teamCanvases}
      canvas={quieter(f.teamCanvases)}
      contributors={f.contributors}
      thread={t.everyKind}
      agent={WORKING}
    />
  ),
  "limit-teammate": () => (
    <CanvasHarness
      canvases={f.teamCanvases}
      canvas={quieter(f.teamCanvases)}
      contributors={f.contributors}
      thread={t.teamThread}
      agent={IDLE}
      gate={{ kind: "claude_limit", owner: f.maya, until: "2026-11-10T21:00:00Z" }}
    />
  ),
  "thread-model-changed": () => (
    <CanvasHarness
      canvases={f.teamCanvases}
      canvas={quieter(f.teamCanvases)}
      contributors={f.contributors}
      thread={t.modelChangedTurn}
      agent={IDLE}
    />
  ),
  "thread-read-only": () => (
    <CanvasHarness
      canvases={f.teamCanvases}
      canvas={quieter(f.teamCanvases)}
      contributors={f.contributors}
      thread={t.teamThread}
      agent={t.teamAgent}
      gate={{ kind: "read_only", repo: f.fernwood }}
    />
  ),
  "pull-request-busy": () => (
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={{ ...quieter(f.soloCanvases), pullRequest: { ...f.pr412, state: "draft" } }}
      contributors={null}
      thread={t.heroThread}
      agent={t.heroAgent}
      pullRequest={{ kind: "ready", pr: t.busyPullRequest }}
      tab="pull-request"
    />
  ),
  "pull-request-merged": () => (
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={{ ...quieter(f.soloCanvases), pullRequest: { ...f.pr412, state: "merged" } }}
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
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={{ ...quieter(f.soloCanvases), pullRequest: { ...f.pr412, state: "merged" } }}
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
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={quieter(f.soloCanvases)}
      contributors={null}
      thread={t.heroThread}
      agent={IDLE}
      pullRequest={{ kind: "ready", pr: t.pullRequest }}
      tab="pull-request"
      rail={false}
    />
  ),
  "pull-request-min-window": () => (
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={quieter(f.soloCanvases)}
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
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={quieter(f.soloCanvases)}
      contributors={null}
      thread={t.heroThread}
      agent={IDLE}
      pullRequest={{ kind: "ready", pr: t.pullRequest }}
      tab="pull-request"
      sidebar="closed"
    />
  ),
  "pull-request-loading": () => (
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={quieter(f.soloCanvases)}
      contributors={null}
      thread={t.heroThread}
      agent={t.heroAgent}
      pullRequest={{ kind: "loading", summary: f.pr412 }}
      tab="pull-request"
    />
  ),
  "pull-request-error": () => (
    <CanvasHarness
      canvases={f.soloCanvases}
      canvas={quieter(f.soloCanvases)}
      contributors={null}
      thread={t.heroThread}
      agent={t.heroAgent}
      pullRequest={{ kind: "error", summary: f.pr412 }}
      tab="pull-request"
    />
  ),
};
