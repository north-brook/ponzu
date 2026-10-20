import { type Author, type Doc, describeNode, locate, newId, type Thread } from "@ponzu/core";
import { useEffect, useRef, useState } from "react";
import type { CanvasSource } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { Button, cn, ToggleGroup } from "./ui.tsx";

/** A card floating over the canvas: a thread, or the composer for a new one. */
export const threadCard =
  "pz:absolute pz:-top-6 pz:left-[30px] pz:w-[300px] pz:select-text pz:overflow-hidden pz:rounded-xl pz:bg-card pz:shadow-pop";
const meta = "pz:text-[11.5px] pz:text-muted-foreground";
const messageText = "pz:whitespace-pre-wrap pz:[overflow-wrap:anywhere]";

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

export function Avatar({ author, size = 20 }: { author: Author; size?: number }) {
  return (
    <span
      className={cn(
        "pz:inline-grid pz:shrink-0 pz:place-items-center pz:rounded-full pz:font-semibold",
        author.kind === "agent"
          ? "pz:bg-comment-soft pz:text-comment-foreground pz:dark:text-comment"
          : "pz:bg-muted pz:text-foreground",
      )}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initials(author.name)}
    </span>
  );
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
  useEffect(() => ref.current?.focus(), []);
  const submit = () => {
    const t = text.trim();
    if (t) onSubmit(t);
  };
  return (
    <div
      className="pz:flex pz:items-end pz:gap-1.5 pz:border-t pz:p-2 pz:only:border-t-0"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        className="pz:min-h-11 pz:flex-1 pz:resize-none pz:bg-transparent pz:p-1 pz:outline-0"
        ref={ref}
        value={text}
        placeholder={placeholder}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
          e.stopPropagation();
        }}
      />
      <Button size="icon-lg" disabled={!text.trim()} onClick={submit} aria-label="Send">
        <Icon name="send" size={14} />
      </Button>
    </div>
  );
}

export function ThreadCard({
  thread,
  doc,
  source,
  me,
  onClose,
}: {
  thread: Thread;
  doc: Doc;
  source: CanvasSource;
  me: Author;
  onClose: () => void;
}) {
  const node = thread.nodeId ? locate(doc, thread.nodeId)?.node : undefined;
  const reply = (text: string) =>
    source.apply({
      op: "thread.message",
      id: thread.id,
      message: { id: newId("m"), author: me, text, createdAt: Date.now() },
    });
  const toggle = () =>
    source.apply({
      op: "thread.update",
      id: thread.id,
      status: thread.status === "open" ? "resolved" : "open",
    });
  return (
    <div
      className={threadCard}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="pz:flex pz:items-center pz:gap-0.5 pz:border-b pz:pt-2 pz:pr-2 pz:pb-1.5 pz:pl-3">
        <span className="pz:flex-1 pz:truncate pz:text-muted-foreground pz:text-xs">
          {node ? describeNode(node) : "Artboard"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          title={thread.status === "open" ? "Resolve" : "Reopen"}
        >
          <Icon name={thread.status === "open" ? "check" : "refresh"} size={15} />
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close">
          <Icon name="close" size={15} />
        </Button>
      </div>
      <div className="pz:max-h-80 pz:overflow-auto pz:py-1.5">
        {thread.messages.map((m) => (
          <div key={m.id} className="pz:flex pz:gap-2 pz:px-3 pz:py-1.5">
            <Avatar author={m.author} />
            <div>
              <div className={meta}>
                <b className="pz:font-semibold pz:text-foreground">{m.author.name}</b>{" "}
                <span>{timeAgo(m.createdAt)}</span>
              </div>
              <div className={messageText}>{m.text}</div>
            </div>
          </div>
        ))}
      </div>
      <Composer onSubmit={reply} onCancel={onClose} placeholder="Reply…" />
    </div>
  );
}

/** Sidebar list of threads, opened from the footer's comments button. */
export function CommentsPanel({
  doc,
  onOpen,
  onClose,
}: {
  doc: Doc;
  onOpen: (t: Thread) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const threads = doc.threads
    .filter((t) => t.status === filter)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div
      className="pz:absolute pz:top-3 pz:right-3 pz:bottom-3 pz:z-[3] pz:w-80 pz:select-text pz:overflow-auto pz:rounded-xl pz:bg-card pz:shadow-pop"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="pz:sticky pz:top-0 pz:flex pz:items-center pz:justify-between pz:border-b pz:bg-card pz:py-2.5 pz:pr-2.5 pz:pl-3">
        <ToggleGroup
          variant="segmented"
          value={filter}
          onValueChange={setFilter}
          items={[
            { value: "open", label: "Open" },
            { value: "resolved", label: "Resolved" },
          ]}
        />
        <Button variant="ghost" size="icon" onClick={onClose} title="Close">
          <Icon name="close" size={15} />
        </Button>
      </div>
      {threads.length === 0 && (
        <div className="pz:px-4 pz:py-6 pz:text-center pz:text-muted-foreground">
          {filter === "open"
            ? "No open comments. Press C and click anywhere to leave one."
            : "Nothing resolved yet."}
        </div>
      )}
      {threads.map((t) => {
        const ab = doc.pages.flatMap((p) => p.artboards).find((a) => a.id === t.artboardId);
        const last = t.messages[t.messages.length - 1];
        return (
          <button
            type="button"
            key={t.id}
            className="pz:flex pz:w-full pz:gap-2.5 pz:border-b pz:px-3 pz:py-2.5 pz:text-left pz:hover:bg-comment-soft"
            onClick={() => onOpen(t)}
          >
            <Avatar author={t.messages[0]!.author} />
            <div>
              <div className={messageText}>{t.messages[0]?.text}</div>
              <div className={meta}>
                {ab?.name ?? "—"} ·{" "}
                {t.messages.length > 1
                  ? `${last?.author.name} replied`
                  : t.messages[0]?.author.name}{" "}
                · {timeAgo(t.updatedAt)}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
