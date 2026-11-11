import { type ReactNode, type RefObject, useLayoutEffect, useMemo, useRef } from "react";
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
import { safeHref } from "../ui/markdown.ts";
import { quietFocus } from "../ui/quiet-focus.ts";
import { overlayOpen } from "../ui/shortcut.ts";
import { RailComposer, ReadOnlyLine } from "./composer.tsx";
import { readDraft, restoreDraft, useDraft, writeDraft } from "./composer-rules.ts";
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
  /** The viewer started answering an ask. */
  onTouchAsk?: (askId: string) => void;
  onConnectClaude?: () => void;
}

/**
 * The thread rail's content (AppWindow's `rail`): the thread, and at its foot the composer, or
 * what the agent waits on in the composer's place, or for someone who can only read, one line
 * that says so. No header, no title: the thread is the design's one conversation.
 */
export function ThreadRail(props: ThreadRailProps) {
  const { designId, meId, items, gate, asks, agent } = props;
  const [draft, setDraft] = useDraft(meId, designId);

  // The lines take handlers that never change, so typing a draft redraws none of them. Every
  // address a line opens (a link in a reply, a hand-off, an attachment) is checked once, here.
  const latest = useRef(props);
  latest.current = props;
  const handlers = useMemo<LineHandlers>(
    () => ({
      renderDrawing: (messageId) => latest.current.renderDrawing(messageId),
      onOpenComment: (threadId, messageId) => latest.current.onOpenComment(threadId, messageId),
      onOpenArtboards: (ids) => latest.current.onOpenArtboards(ids),
      onOpenPullRequest: () => latest.current.onOpenPullRequest(),
      onOpenLink: (url) => {
        const href = safeHref(url);
        if (href) latest.current.onOpenLink(href);
      },
      onRetryMessage: (id) => latest.current.onRetryMessage?.(id),
      // Its words go back in the field, ahead of anything typed since, and the bubble goes.
      onEditMessage: (id) => {
        const { items, meId, designId, onEditMessage } = latest.current;
        const item = items?.find((candidate) => candidate.id === id);
        if (item?.kind === "message") {
          writeDraft(meId, designId, restoreDraft(item.payload.text, readDraft(meId, designId)));
        }
        onEditMessage?.(id);
      },
    }),
    [],
  );

  const send = () => {
    const text = draft;
    setDraft("");
    Promise.resolve(props.onSend(text)).catch(() =>
      setDraft(restoreDraft(text, readDraft(meId, designId))),
    );
  };

  // The keyboard was in the composer's slot when what fills it changed: it goes to what came.
  const carry = useRef(false);
  const slot = gate?.kind === "read_only" ? "read" : asks.length ? "ask" : "compose";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {items ? (
        <ThreadView
          // Another design's thread opens at its own foot, following.
          key={designId}
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
      <Slot key={`${designId}:${slot}`} carry={carry}>
        {gate?.kind === "read_only" ? (
          <ReadOnlyLine
            message={gateMessage(gate, meId)}
            whole={gate.repo ? `${gate.repo.owner}/${gate.repo.name}` : null}
          />
        ) : asks.length ? (
          <NeedsYou
            asks={asks}
            meId={meId}
            repoName={props.repoName}
            onAnswer={props.onAnswer}
            onDismiss={props.onDismissAsk}
            onOpenLink={handlers.onOpenLink}
            {...(props.onTouchAsk ? { onTouch: props.onTouchAsk } : {})}
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
      </Slot>
    </div>
  );
}

/** Where the keyboard lands in what fills the slot: an ask's options, else its field. */
const LANDING = [
  '[data-option]:not([tabindex="-1"]):enabled',
  "textarea:enabled",
  'input:enabled:not([type="file"])',
];

/** Something a person types into: what has the keyboard there is theirs to keep. */
const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * The thread pane has just opened (`pane`, AppWindow's rail): the keyboard goes to what fills
 * the composer's slot, so opening it is ready to say something. The composer's field; a
 * question's first option, when one waits in its place; nothing for someone who can only read.
 * Never under a menu, popover or dialog, and never from a field elsewhere that has the caret
 * (the sidebar's search, a rename, text on the canvas). Without scrolling, and without a ring.
 */
export function enterThread(pane: HTMLElement): void {
  if (overlayOpen() || pane.inert) return;
  const active = document.activeElement;
  if (active && active !== document.body) {
    if (pane.contains(active) || active.matches(FIELD)) return;
  }
  for (const selector of LANDING) {
    const target = pane.querySelector<HTMLElement>(selector);
    if (target) {
      quietFocus(target);
      return;
    }
  }
}

/**
 * The composer's slot, holding one thing: the composer, what the agent waits on, or the
 * read-only line. A question arriving under someone's caret, or the last answer going out, swaps
 * it; if the keyboard was in what left, it lands in what came, instead of falling to the window.
 */
function Slot({ carry, children }: { carry: RefObject<boolean>; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current!;
    if (carry.current) {
      carry.current = false;
      for (const selector of LANDING) {
        const target = el.querySelector<HTMLElement>(selector);
        if (target) {
          quietFocus(target);
          break;
        }
      }
    }
    // A layout effect's cleanup runs before its DOM leaves, while the focus is still inside.
    return () => {
      carry.current = el.contains(document.activeElement);
    };
  }, [carry]);
  return (
    <div ref={box} className="contents">
      {children}
    </div>
  );
}
