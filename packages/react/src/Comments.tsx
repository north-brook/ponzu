import { type Author, type Doc, describeNode, locate, newId, type Thread } from "@ponzu/core";
import { useEffect, useRef, useState } from "react";
import type { CanvasSource } from "./connection.ts";
import { Icon } from "./icons.tsx";

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
      className={`pz-avatar ${author.kind === "agent" ? "pz-avatar-agent" : ""}`}
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
    <div className="pz-composer" onPointerDown={(e) => e.stopPropagation()}>
      <textarea
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
      <button
        type="button"
        className="pz-send"
        disabled={!text.trim()}
        onClick={submit}
        aria-label="Send"
      >
        <Icon name="send" size={14} />
      </button>
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
      className="pz-thread"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="pz-thread-head">
        <span className="pz-thread-where">{node ? describeNode(node) : "Artboard"}</span>
        <button
          type="button"
          className="pz-icon-btn"
          onClick={toggle}
          title={thread.status === "open" ? "Resolve" : "Reopen"}
        >
          <Icon name={thread.status === "open" ? "check" : "refresh"} size={15} />
        </button>
        <button type="button" className="pz-icon-btn" onClick={onClose} title="Close">
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="pz-thread-messages">
        {thread.messages.map((m) => (
          <div key={m.id} className="pz-message">
            <Avatar author={m.author} />
            <div>
              <div className="pz-message-meta">
                <b>{m.author.name}</b> <span>{timeAgo(m.createdAt)}</span>
              </div>
              <div className="pz-message-text">{m.text}</div>
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
      className="pz-panel"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="pz-panel-head">
        <div className="pz-seg">
          <button
            type="button"
            className={filter === "open" ? "on" : ""}
            onClick={() => setFilter("open")}
          >
            Open
          </button>
          <button
            type="button"
            className={filter === "resolved" ? "on" : ""}
            onClick={() => setFilter("resolved")}
          >
            Resolved
          </button>
        </div>
        <button type="button" className="pz-icon-btn" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      {threads.length === 0 && (
        <div className="pz-empty">
          {filter === "open"
            ? "No open comments. Press C and click anywhere to leave one."
            : "Nothing resolved yet."}
        </div>
      )}
      {threads.map((t) => {
        const ab = doc.pages.flatMap((p) => p.artboards).find((a) => a.id === t.artboardId);
        const last = t.messages[t.messages.length - 1];
        return (
          <button type="button" key={t.id} className="pz-panel-row" onClick={() => onOpen(t)}>
            <Avatar author={t.messages[0]!.author} />
            <div>
              <div className="pz-message-text">{t.messages[0]?.text}</div>
              <div className="pz-message-meta">
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
