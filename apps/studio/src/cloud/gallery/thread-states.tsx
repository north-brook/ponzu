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
          renderBoard={() => <span className="block size-full bg-chip" />}
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
          designId="read"
          gate={{ kind: "read_only", repo: f.fernwood }}
          label="read-only access"
        />
        <Rail designId="loading" thread={null} label="loading" />
        <Rail designId="kinds" thread={t.everyKind} agent={WORKING} label="every kind of line" />
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
      </Section>
    </>
  );
}
