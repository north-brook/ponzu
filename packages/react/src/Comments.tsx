import { type Author, newId, type Thread } from "@ponzu/core";
import { useEffect, useRef, useState } from "react";
import type { CanvasSource } from "./connection.ts";
import { AgentMark, Icon } from "./icons.tsx";
import { Button, cn } from "./ui.tsx";

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
  // Wait a frame: the click that opened the composer focuses the canvas after
  // this mounts, which would take focus straight back.
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const submit = () => {
    const t = text.trim();
    if (t) onSubmit(t);
  };
  return (
    <div
      className="pz:flex pz:items-end pz:gap-2 pz:border-t pz:py-2 pz:pr-2 pz:pl-3.5 pz:only:border-t-0"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        className="pz:field-sizing-content pz:max-h-40 pz:min-h-7 pz:flex-1 pz:resize-none pz:bg-transparent pz:py-1 pz:text-[13.5px] pz:leading-[1.55] pz:outline-0 pz:placeholder:text-muted-foreground"
        ref={ref}
        value={text}
        placeholder={placeholder}
        rows={1}
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
  source,
  me,
  onClose,
}: {
  thread: Thread;
  source: CanvasSource;
  me: Author;
  onClose: () => void;
}) {
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
  const mine = (a: Author) => a.kind === me.kind && a.name === me.name;
  return (
    <div
      className={threadCard}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="pz:absolute pz:top-1.5 pz:right-1.5 pz:z-[1] pz:flex pz:gap-0.5 pz:rounded-lg pz:bg-card">
        <Button variant="ghost" size="icon" onClick={resolve} title="Resolve">
          <Icon name="check" size={15} />
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close">
          <Icon name="close" size={15} />
        </Button>
      </div>
      <div className="pz:flex pz:max-h-80 pz:flex-col pz:gap-3.5 pz:overflow-auto pz:pt-3 pz:pr-16 pz:pb-3.5 pz:pl-3.5">
        {thread.messages.map((m) => (
          <div key={m.id} className="pz:flex pz:flex-col pz:gap-1">
            {!mine(m.author) && (
              <div className="pz:flex pz:items-center pz:gap-1.5">
                <Avatar author={m.author} size={18} />
                <span className="pz:font-medium">{m.author.name}</span>
                <span className={meta}>{timeAgo(m.createdAt)}</span>
              </div>
            )}
            <div className={messageText}>{m.text}</div>
          </div>
        ))}
      </div>
      <Composer onSubmit={reply} onCancel={onClose} placeholder="Reply…" />
    </div>
  );
}
