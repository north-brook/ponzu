/* The thread rail, needs you and the pull request mark in the states the boards don't draw. */
import type { ReactNode } from "react";
import type { AgentActivity, Ask, PendingAttachment, SteerGate, ThreadItem } from "../model.ts";
import { ThreadRail } from "../thread/rail.tsx";
import { NextActionButton } from "../window/next-action.tsx";
import * as f from "./fixtures.ts";
import * as t from "./thread-fixtures.ts";

const ignore = () => {};
const WORKING: AgentActivity = { state: "working", status: null };
const IDLE: AgentActivity = { state: "idle", status: null };
const WAITING: AgentActivity = { state: "needs_you", status: null };
const LIMIT: SteerGate = { kind: "claude_limit", owner: f.ada, until: "2026-11-10T21:00:00Z" };

/** A rail at its size, on the chrome, as the window holds it. */
function Rail({
  label,
  thread = t.setUpThread,
  agent = IDLE,
  asks = [],
  gate = null,
  attachments = [],
  canvasId,
}: {
  label: string;
  thread?: ThreadItem[] | null;
  agent?: AgentActivity;
  asks?: Ask[];
  gate?: SteerGate | null;
  attachments?: PendingAttachment[];
  canvasId: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex h-[560px] w-[360px] flex-col bg-chrome px-2.5 pb-2.5">
        <ThreadRail
          canvasId={`states_${canvasId}`}
          meId={f.ada.id}
          repoName="fernwood"
          items={thread}
          older="none"
          onLoadOlder={ignore}
          agent={agent}
          asks={asks}
          gate={gate}
          attachments={attachments}
          onAttach={ignore}
          onRemoveAttachment={ignore}
          onRetryAttachment={ignore}
          onSend={ignore}
          onStop={ignore}
          onAnswer={ignore}
          onDismissAsk={ignore}
          onConnectClaude={ignore}
          // The scene the picture is made from, which the canvas draws: its ground here.
          renderDrawing={() => <span className="block size-full bg-canvas" />}
          onOpenComment={ignore}
          onOpenArtboards={ignore}
          onOpenPullRequest={ignore}
          onOpenLink={ignore}
        />
      </div>
      <span className="text-11 text-faint">{label}</span>
    </div>
  );
}

const pending: PendingAttachment[] = [
  {
    id: "a1",
    name: "hero.png",
    previewUrl: f.heroResults.canvases[0]!.canvas.preview!.light,
    status: "ready",
  },
  {
    id: "a2",
    name: "crop.png",
    previewUrl: f.heroResults.canvases[0]!.canvas.preview!.light,
    status: "uploading",
  },
  {
    id: "a3",
    name: "big.png",
    previewUrl: f.heroResults.canvases[0]!.canvas.preview!.light,
    status: "failed",
  },
];

/** The viewer's two newest messages: one still on its way, one that didn't arrive. */
const unsent: ThreadItem[] = [
  ...t.setUpThread,
  ...(["sending", "failed"] as const).map(
    (delivery, i): ThreadItem => ({
      id: `unsent-${delivery}`,
      seq: 1000 + i,
      at: "2026-11-10T12:00:00Z",
      streaming: false,
      kind: "message",
      payload: {
        text: delivery === "sending" ? "Keep the green." : "And a fourth plan, for teams.",
        from: f.ada,
        attachments: [],
        delivery,
      },
    }),
  ),
];

/** A comment with its picture, a reply to it, and a short one. */
const commented: ThreadItem[] = [
  t.said(f.ada, "Give me three takes on the hero. Keep the green."),
  t.comment(f.ada, "Too many words here. Calmer, and put a quieter take beside it."),
  t.reply("Folding that into B: no paragraph, and the photo does the talking."),
  t.comment(f.ada, "Yes"),
];

/** The viewer's own comment the moment it is sent, its picture's files still being made. */
const drawing: ThreadItem[] = [
  t.said(f.ada, "Give me three takes on the hero. Keep the green."),
  t.comment(f.ada, "Too many words here.", { kind: "drawing", width: 240, height: 160 }),
];

/** Comments with no picture to show: on a board, and on the ground of a page. */
const placed: ThreadItem[] = [
  t.comment(f.ada, "Too many words here. Calmer, and put a quieter take beside it.", null),
  t.comment(f.ada, "Something to go between these two", null, {
    artboardName: null,
    pageName: "Checkout",
  }),
];

export function ThreadStates({
  Section,
}: {
  Section: (p: { title: string; children: ReactNode }) => ReactNode;
}) {
  return (
    <>
      <Section title="Thread rail · composer">
        <Rail canvasId="idle" label="idle: Send, waiting for words" />
        <Rail canvasId="working" agent={WORKING} label="working: Stop until there are words" />
        <Rail
          canvasId="waking"
          agent={{ state: "waking", status: null }}
          thread={t.setUpThread.slice(0, 1)}
          label="waking up"
        />
        <Rail canvasId="attach" attachments={pending} label="images: ready, uploading, failed" />
        <Rail canvasId="limit" gate={LIMIT} label="the owner's plan at its limit" />
        <Rail
          canvasId="limit-you"
          gate={{ kind: "claude_disconnected", owner: f.ada }}
          label="your Claude disconnected"
        />
        <Rail
          canvasId="limit-maya"
          gate={{ kind: "claude_disconnected", owner: f.maya }}
          label="Maya's Claude disconnected"
        />
        <Rail
          canvasId="expired"
          gate={{ kind: "claude_expired", owner: f.ada }}
          label="your Claude sign-in ran out"
        />
        <Rail
          canvasId="owner-left"
          gate={{ kind: "claude_owner_left" }}
          label="its owner left the workspace"
        />
        <Rail
          canvasId="busy"
          agent={{ state: "waking", status: null, sandbox: "busy" }}
          label="waiting for a free machine"
        />
        <Rail
          canvasId="failed"
          agent={{ state: "idle", status: null, sandbox: "failed" }}
          label="a machine couldn't start"
        />
        <Rail canvasId="unsent" thread={unsent} label="a message on its way, and one that failed" />
        <Rail
          canvasId="read"
          gate={{ kind: "read_only", repo: f.fernwood }}
          label="read-only access"
        />
        <Rail canvasId="loading" thread={null} label="loading" />
        <Rail canvasId="kinds" thread={t.everyKind} agent={WORKING} label="every kind of line" />
      </Section>
      <Section title="Thread rail · turns">
        <Rail
          canvasId="turn-drawing"
          thread={t.runningTurn}
          agent={{ state: "working", status: 'Drawing "5 · Schedule"' }}
          label="running: drawing a board"
        />
        <Rail
          canvasId="turn-thinking"
          thread={t.runningTurn}
          agent={{ state: "working", status: "Thinking" }}
          label="running: thinking, after it spoke"
        />
        <Rail
          canvasId="turn-reading"
          thread={t.runningTurn}
          agent={{ state: "working", status: "Reading src/app/page.tsx" }}
          label="running: reading a file"
        />
        <Rail canvasId="turn-done" thread={t.completedTurn} label="completed: only its answer" />
        <Rail canvasId="turn-stopped" thread={t.stoppedTurn} label="stopped mid-work" />
        <Rail canvasId="turn-failed" thread={t.failedTurn} label="failed" />
        <Rail canvasId="turn-asked" thread={t.askedTurn} label="ended on a question" />
        <Rail canvasId="turn-old" thread={t.oldFormatThread} label="an older runner's thread" />
      </Section>
      <Section title="Thread rail · comments from the canvas">
        <Rail canvasId="comment-picture" thread={commented} label="with the picture of where" />
        <Rail
          canvasId="comment-drawing"
          thread={drawing}
          label="your own, its picture still being drawn"
        />
        <Rail
          canvasId="comment-place"
          thread={placed}
          label="no picture: older, too large, or gone"
        />
      </Section>
      <Section title="Needs you">
        <Rail
          canvasId="q2"
          agent={WAITING}
          asks={[t.twoQuestionAsk]}
          label="two questions in one ask"
        />
        <Rail canvasId="plan" agent={WAITING} asks={[t.planAsk]} label="a plan to approve" />
        <Rail canvasId="perm" agent={WAITING} asks={[t.permissionAsk]} label="a permission" />
        <Rail canvasId="secret" agent={WAITING} asks={[t.secretAsk]} label="a secret" />
        <Rail canvasId="link" agent={WAITING} asks={[t.linkAsk]} label="a hand-off link" />
        <Rail
          canvasId="sending"
          agent={WAITING}
          asks={[{ ...t.planAsk, status: "sending" }]}
          label="your answer on its way"
        />
        <Rail
          canvasId="answered"
          agent={WAITING}
          asks={[{ ...t.boardAsks[0]!, status: "answered", answeredBy: f.maya }, t.boardAsks[1]!]}
          label="answered by someone else"
        />
        <Rail
          canvasId="withdrawn"
          agent={IDLE}
          asks={[{ ...t.permissionAsk, status: "cancelled" }]}
          label="withdrawn: the run moved on"
        />
      </Section>
      <Section title="Next action, blocked">
        <NextActionButton
          action="merge"
          blocked="Needs write access to thistlewick/fernwood"
          onRun={ignore}
        />
        <NextActionButton
          action="fix_checks"
          blocked="Ada's plan is at its limit until 4:00 PM. This canvas waits."
          onRun={ignore}
        />
        <NextActionButton action="update_branch" onRun={ignore} />
        <NextActionButton action="blocked" onRun={ignore} />
        <NextActionButton action="merge" busy onRun={ignore} />
      </Section>
    </>
  );
}
