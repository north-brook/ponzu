import { useMemo, useRef } from "react";
import { gateMessage } from "../gate.ts";
import type {
  AgentActivity,
  Ask,
  AskAnswer,
  OlderItems,
  PendingAttachment,
  SteerGate,
  ThreadItem,
} from "../model.ts";
import { NeedsYou } from "../needs-you/needs-you.tsx";
import { RailComposer, ReadOnlyLine } from "./composer.tsx";
import { useDraft } from "./composer-rules.ts";
import type { LineHandlers } from "./lines.tsx";
import { ThreadSkeleton, ThreadView } from "./thread-view.tsx";

export interface ThreadRailProps extends LineHandlers {
  designId: string;
  meId: string;
  /** The repo a secret is kept with; null for Scratch. */
  repoName: string | null;
  /** The thread, oldest first; null while it loads. */
  items: ThreadItem[] | null;
  older: OlderItems;
  onLoadOlder: () => void;
  agent: AgentActivity;
  /** What the agent waits on, oldest first, and any just closed that the viewer hasn't put away. */
  asks: Ask[];
  gate: SteerGate | null;
  attachments: PendingAttachment[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  /** Sends the message with the attachments that are ready. A rejection gives the draft back. */
  onSend: (text: string) => Promise<void> | void;
  onStop: () => void;
  onAnswer: (askId: string, answer: AskAnswer) => void;
  onDismissAsk: (askId: string) => void;
  onConnectClaude?: () => void;
}

/**
 * The thread rail's content (AppWindow's `rail`): the thread, and at its foot the composer, or
 * what the agent waits on in the composer's place, or for someone who can only read, one line
 * that says so. No header, no title: the thread is the design's one conversation.
 */
export function ThreadRail(props: ThreadRailProps) {
  const { designId, meId, items, gate, asks, agent } = props;
  const [draft, setDraft] = useDraft(designId);

  // The lines take handlers that never change, so typing a draft redraws none of them.
  const latest = useRef(props);
  latest.current = props;
  const handlers = useMemo<LineHandlers>(
    () => ({
      renderBoard: (id) => latest.current.renderBoard(id),
      onOpenComment: (id) => latest.current.onOpenComment(id),
      onOpenArtboards: (ids) => latest.current.onOpenArtboards(ids),
      onOpenPullRequest: () => latest.current.onOpenPullRequest(),
      onOpenLink: (url) => latest.current.onOpenLink(url),
    }),
    [],
  );

  const send = () => {
    const text = draft;
    setDraft("");
    Promise.resolve(props.onSend(text)).catch(() => setDraft(text));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {items ? (
        <ThreadView
          items={items}
          older={props.older}
          onLoadOlder={props.onLoadOlder}
          agent={agent}
          meId={meId}
          handlers={handlers}
        />
      ) : (
        <ThreadSkeleton />
      )}
      {gate?.kind === "read_only" ? (
        <ReadOnlyLine message={gateMessage(gate, meId)} />
      ) : asks.length ? (
        <NeedsYou
          asks={asks}
          meId={meId}
          repoName={props.repoName}
          onAnswer={props.onAnswer}
          onDismiss={props.onDismissAsk}
          onOpenLink={props.onOpenLink}
        />
      ) : (
        <RailComposer
          text={draft}
          onTextChange={setDraft}
          working={agent.state === "working" || agent.state === "waking"}
          gate={gate}
          meId={meId}
          attachments={props.attachments}
          onAttach={props.onAttach}
          onRemoveAttachment={props.onRemoveAttachment}
          onRetryAttachment={props.onRetryAttachment}
          onSend={send}
          onStop={props.onStop}
          onConnectClaude={props.onConnectClaude}
        />
      )}
    </div>
  );
}
