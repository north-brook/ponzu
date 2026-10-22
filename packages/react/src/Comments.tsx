import { type Author, newId, type Thread } from "@ponzu/core";
import { useEffect, useRef, useState } from "react";
import type { CanvasSource } from "./connection.ts";
import { AgentMark, Icon } from "./icons.tsx";
import { Button, cn, Menu, Textarea } from "./ui.tsx";

/** A card floating over the canvas: a thread, or the composer for a new one. */
export const threadCard =
  "pz:absolute pz:-top-3 pz:left-5 pz:w-[300px] pz:select-text pz:overflow-hidden pz:rounded-xl pz:bg-card pz:shadow-pop";
const meta = "pz:text-[11.5px] pz:text-muted-foreground";
const messageText =
  "pz:whitespace-pre-wrap pz:text-[13.5px] pz:leading-[1.55] pz:[overflow-wrap:anywhere]";

export function timeAgo(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** The product behind an agent author, for its logo. Agents are named after their client. */
function agentClient(author: Author): "claude" | "openai" | null {
  if (author.kind !== "agent") return null;
  const n = author.name.toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex") || n.includes("openai") || n.includes("chatgpt")) return "openai";
  return null;
}

export function Avatar({ author, size = 20 }: { author: Author; size?: number }) {
  const client = agentClient(author);
  if (client)
    return (
      <span
        className="pz:inline-grid pz:shrink-0 pz:place-items-center pz:text-foreground"
        style={{ width: size, height: size }}
      >
        <AgentMark client={client} size={size} />
      </span>
    );
  return (
    <span
      className={cn(
        "pz:inline-grid pz:shrink-0 pz:place-items-center pz:rounded-full pz:font-semibold",
        author.kind === "agent"
          ? "pz:bg-comment-soft pz:text-foreground"
          : "pz:bg-muted pz:text-foreground",
      )}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initials(author.name)}
    </span>
  );
}

/** Enter sends, Shift+Enter breaks the line, Esc cancels. Keys stay out of the canvas. */
function onFieldKey(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  submit: () => void,
  cancel: () => void,
) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
  if (e.key === "Escape") cancel();
  e.stopPropagation();
}

/** Focus a field once it mounts, caret at the end. */
function useAutofocus(ref: React.RefObject<HTMLTextAreaElement | null>) {
  // Wait a frame: the click that opened it focuses the canvas after this
  // mounts, which would take focus straight back.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      // A card that runs past the canvas's edge would otherwise scroll the
      // canvas itself, shifting every pin and board.
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [ref]);
}

/** The comment composer that appears where you clicked in comment mode. */
export function Composer({
  onSubmit,
  onCancel,
  placeholder = "Leave a comment…",
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutofocus(ref);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmit(t);
    // A reply's composer stays open for the next message.
    setText("");
  };
  return (
    <div
      className="pz:flex pz:items-end pz:gap-2 pz:border-t pz:py-2 pz:pr-2 pz:pl-3.5 pz:only:border-t-0"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Textarea
        className="pz:max-h-40 pz:flex-1 pz:text-[13.5px] pz:leading-[1.55]"
        ref={ref}
        value={text}
        placeholder={placeholder}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => onFieldKey(e, submit, onCancel)}
      />
      <Button size="icon-lg" disabled={!text.trim()} onClick={submit} aria-label="Send">
        <Icon name="send" size={14} />
      </Button>
    </div>
  );
}

/** Edits one of your messages in place. */
function EditField({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutofocus(ref);
  const save = () => {
    const t = text.trim();
    if (t && t !== initial) onSave(t);
    else onCancel();
  };
  return (
    <div className="pz:flex pz:flex-col pz:gap-1.5">
      <Textarea
        className="pz:max-h-60 pz:rounded-lg pz:px-2 pz:text-[13.5px] pz:leading-[1.55] pz:ring-[1.5px] pz:ring-select"
        ref={ref}
        value={text}
        aria-label="Edit message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => onFieldKey(e, save, onCancel)}
      />
      <div className="pz:flex pz:items-center pz:justify-end pz:gap-1">
        <span className={cn(meta, "pz:mr-auto")}>Enter to save · Esc to cancel</span>
        <Button variant="ghost" className="pz:h-6 pz:rounded-md pz:px-2" onClick={onCancel}>
          Cancel
        </Button>
        <Button className="pz:h-6 pz:rounded-md pz:px-2" disabled={!text.trim()} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

export function ThreadCard({
  thread,
  source,
  me,
  readOnly = false,
  onClose,
}: {
  thread: Thread;
  source: CanvasSource;
  me: Author;
  /** Only the messages: no reply, resolve, edit or delete. */
  readOnly?: boolean;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const reply = (text: string) =>
    source.apply({
      op: "thread.message",
      id: thread.id,
      message: { id: newId("m"), author: me, text, createdAt: Date.now() },
    });
  const resolve = () => {
    source.apply({ op: "thread.update", id: thread.id, status: "resolved" });
    onClose();
  };
  const remove = () => {
    source.apply({ op: "thread.delete", id: thread.id });
    onClose();
  };
  const edit = (messageId: string, text: string) => {
    source.apply({ op: "thread.edit", id: thread.id, messageId, text, editedAt: Date.now() });
    setEditing(null);
  };
  const removeMessage = (messageId: string) =>
    source.apply({ op: "thread.unmessage", id: thread.id, messageId });
  const mine = (a: Author) => !readOnly && a.kind === me.kind && a.name === me.name;
  // The first message is the comment itself. Its actions live in the card's
  // menu, so nothing appears on hover beside the Resolve and More buttons.
  const first = thread.messages[0];
  const hoverActions = (m: Thread["messages"][number], i: number) =>
    i > 0 && mine(m.author) && editing !== m.id;
  return (
    <div className={threadCard} onPointerDown={(e) => e.stopPropagation()}>
      {!readOnly && (
        <div className="pz:absolute pz:top-1.5 pz:right-1.5 pz:z-[1] pz:flex pz:gap-0.5 pz:rounded-lg pz:bg-card">
          <Button variant="ghost" size="icon" onClick={resolve} title="Resolve">
            <Icon name="check" size={15} />
          </Button>
          <Menu
            trigger={
              <Button variant="ghost" size="icon" title="More">
                <Icon name="more" size={15} />
              </Button>
            }
            items={[
              ...(first && mine(first.author)
                ? [
                    {
                      label: "Edit",
                      icon: <Icon name="edit" size={14} />,
                      onSelect: () => setEditing(first.id),
                    },
                  ]
                : []),
              {
                label: "Delete thread",
                icon: <Icon name="trash" size={14} />,
                danger: true,
                onSelect: remove,
              },
            ]}
          />
        </div>
      )}
      {/*
        data-scroll lets the wheel scroll this list instead of panning the canvas.
        Scrolled, its top fades out so messages never run under the buttons.
      */}
      <div
        data-scroll
        className={cn(
          "pz:flex pz:max-h-80 pz:flex-col pz:gap-1 pz:overflow-y-auto pz:overscroll-contain pz:px-1.5 pz:pt-1.5 pz:pb-2.5",
          scrolled && "pz:[mask-image:linear-gradient(transparent_24px,#000_44px)]",
        )}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        {thread.messages.map((m, i) => (
          <div
            key={m.id}
            className={cn(
              "pz:group pz:flex pz:flex-col pz:gap-1 pz:rounded-lg pz:px-2 pz:py-1.5",
              hoverActions(m, i) && "pz:hover:bg-accent",
            )}
          >
            {/* At the top, only the first row sits beside the card's buttons. */}
            <div
              className={cn(
                "pz:flex pz:h-6 pz:items-center pz:gap-1.5",
                i === 0 && !readOnly && "pz:pr-14",
              )}
            >
              <Avatar author={m.author} size={18} />
              <span className="pz:truncate pz:font-medium">{m.author.name}</span>
              <span className={cn(meta, "pz:shrink-0")}>
                {timeAgo(m.createdAt)}
                {m.editedAt ? " · edited" : ""}
              </span>
              {hoverActions(m, i) && (
                <div className="pz:ml-auto pz:flex pz:shrink-0 pz:opacity-0 pz:group-hover:opacity-100 pz:focus-within:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEditing(m.id)}
                    title="Edit"
                  >
                    <Icon name="edit" size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeMessage(m.id)}
                    title="Delete"
                  >
                    <Icon name="trash" size={14} />
                  </Button>
                </div>
              )}
            </div>
            {editing === m.id ? (
              <EditField
                initial={m.text}
                onSave={(text) => edit(m.id, text)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className={messageText}>{m.text}</div>
            )}
          </div>
        ))}
      </div>
      {!readOnly && <Composer onSubmit={reply} onCancel={onClose} placeholder="Reply…" />}
    </div>
  );
}
