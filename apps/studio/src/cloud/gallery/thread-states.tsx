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
const LIMIT: SteerGate = { kind: "claude_limit", owner: f.bryce, until: "2026-11-10T21:00:00Z" };

/** A rail at its size, on the chrome, as the window holds it. */
function Rail({
  label,
  thread = t.setUpThread,
  agent = IDLE,
  asks = [],
  gate = null,
  attachments = [],
  designId,
}: {
  label: string;
  thread?: ThreadItem[] | null;
  agent?: AgentActivity;
  asks?: Ask[];
  gate?: SteerGate | null;
  attachments?: PendingAttachment[];
  designId: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex h-[560px] w-[360px] flex-col bg-chrome px-2.5 pb-2.5">
        <ThreadRail
          designId={`states_${designId}`}
          meId={f.bryce.id}
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
    previewUrl: f.heroResults.designs[0]!.design.preview!.light,
    status: "ready",
  },
  {
    id: "a2",
    name: "crop.png",
    previewUrl: f.heroResults.designs[0]!.design.preview!.light,
    status: "uploading",
  },
  {
    id: "a3",
    name: "big.png",
    previewUrl: f.heroResults.designs[0]!.design.preview!.light,
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
        from: f.bryce,
        attachments: [],
        delivery,
      },
    }),
  ),
];

/** A comment with its picture, a reply to it, and a short one. */
const commented: ThreadItem[] = [
  t.said(f.bryce, "Give me three takes on the hero. Keep the green."),
  t.comment(f.bryce, "Too many words here. Calmer, and put a quieter take beside it."),
  t.reply("Folding that into B: no paragraph, and the photo does the talking."),
  t.comment(f.bryce, "Yes"),
];

/** The viewer's own comment the moment it is sent, its picture's files still being made. */
const drawing: ThreadItem[] = [
  t.said(f.bryce, "Give me three takes on the hero. Keep the green."),
  t.comment(f.bryce, "Too many words here.", { kind: "drawing", width: 240, height: 160 }),
];

/** Comments with no picture to show: on a board, and on the open canvas of a page. */
const placed: ThreadItem[] = [
  t.comment(f.bryce, "Too many words here. Calmer, and put a quieter take beside it.", null),
  t.comment(f.bryce, "Something to go between these two", null, {
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
        <Rail designId="idle" label="idle: Send, waiting for words" />
        <Rail designId="working" agent={WORKING} label="working: Stop until there are words" />
        <Rail
          designId="waking"
          agent={{ state: "waking", status: null }}
          thread={t.setUpThread.slice(0, 1)}
          label="waking up"
        />
        <Rail designId="attach" attachments={pending} label="images: ready, uploading, failed" />
        <Rail designId="limit" gate={LIMIT} label="the owner's plan at its limit" />
        <Rail
          designId="limit-you"
          gate={{ kind: "claude_disconnected", owner: f.bryce }}
          label="your Claude disconnected"
        />
        <Rail
          designId="limit-maya"
          gate={{ kind: "claude_disconnected", owner: f.maya }}
          label="Maya's Claude disconnected"
        />
        <Rail
          designId="expired"
          gate={{ kind: "claude_expired", owner: f.bryce }}
          label="your Claude sign-in ran out"
        />
        <Rail
          designId="owner-left"
          gate={{ kind: "claude_owner_left" }}
          label="its owner left the workspace"
        />
        <Rail
          designId="busy"
          agent={{ state: "waking", status: null, sandbox: "busy" }}
          label="waiting for a free machine"
        />
        <Rail
          designId="failed"
          agent={{ state: "idle", status: null, sandbox: "failed" }}
          label="a machine couldn't start"
        />
        <Rail designId="unsent" thread={unsent} label="a message on its way, and one that failed" />
        <Rail
          designId="read"
          gate={{ kind: "read_only", repo: f.fernwood }}
          label="read-only access"
        />
        <Rail designId="loading" thread={null} label="loading" />
        <Rail designId="kinds" thread={t.everyKind} agent={WORKING} label="every kind of line" />
      </Section>
      <Section title="Thread rail · comments from the canvas">
        <Rail designId="comment-picture" thread={commented} label="with the picture of where" />
        <Rail
          designId="comment-drawing"
          thread={drawing}
          label="your own, its picture still being drawn"
        />
        <Rail
          designId="comment-place"
          thread={placed}
          label="no picture: older, too large, or gone"
        />
      </Section>
      <Section title="Needs you">
        <Rail
          designId="q2"
          agent={WAITING}
          asks={[t.twoQuestionAsk]}
          label="two questions in one ask"
        />
        <Rail designId="plan" agent={WAITING} asks={[t.planAsk]} label="a plan to approve" />
        <Rail designId="perm" agent={WAITING} asks={[t.permissionAsk]} label="a permission" />
        <Rail designId="secret" agent={WAITING} asks={[t.secretAsk]} label="a secret" />
        <Rail designId="link" agent={WAITING} asks={[t.linkAsk]} label="a hand-off link" />
        <Rail
          designId="sending"
          agent={WAITING}
          asks={[{ ...t.planAsk, status: "sending" }]}
          label="your answer on its way"
        />
        <Rail
          designId="answered"
          agent={WAITING}
          asks={[{ ...t.boardAsks[0]!, status: "answered", answeredBy: f.maya }, t.boardAsks[1]!]}
          label="answered by someone else"
        />
        <Rail
          designId="withdrawn"
          agent={IDLE}
          asks={[{ ...t.permissionAsk, status: "cancelled" }]}
          label="withdrawn: the run moved on"
        />
      </Section>
      <Section title="Next action, blocked">
        <NextActionButton
          action="merge"
          blocked="Needs write access to north-brook/fernwood"
          onRun={ignore}
        />
        <NextActionButton
          action="fix_checks"
          blocked="Bryce's plan is at its limit until 4:00 PM. This design waits."
          onRun={ignore}
        />
        <NextActionButton action="update_branch" onRun={ignore} />
        <NextActionButton action="blocked" onRun={ignore} />
        <NextActionButton action="merge" busy onRun={ignore} />
      </Section>
    </>
  );
}
