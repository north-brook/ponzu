import { bySeq, type LiveRows } from "@ponzu/client";
import { useLiveQuery } from "@ponzu/client/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { canSend } from "../cloud/create/create.ts";
import { SendButton } from "../cloud/ui/button.tsx";
import { FadeScroll } from "../cloud/ui/fade-scroll.tsx";
import { type OpenDesign, useSourceState } from "./design.tsx";
import type { Host } from "./host.ts";

/*
 * SEAM(thread rail): the thread track builds the real rail (needs you, the working line,
 * comments with their boards, markdown) against the AppWindow `rail` slot. Until it lands this
 * is the least that keeps a design steerable: the thread as plain lines, live, and a field that
 * sends a message. Replace the component where main-window.tsx mounts it; nothing else uses it.
 */

type ThreadItem = LiveRows["design.thread"];

export function ThreadRail({ host, open }: { host: Host; open: OpenDesign }) {
  const designId = open.id;
  // The source learns whether the person may steer once the API has answered.
  useSourceState(open.source);
  const writable = open.source.writable;
  const { rows } = useLiveQuery("design.thread", { designId });
  const items = rows ? bySeq(rows) : null;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const count = items?.length ?? 0;
  useEffect(() => {
    if (count) end.current?.scrollIntoView({ block: "end" });
  }, [count]);

  const send = async () => {
    if (!canSend(text, sending)) return;
    setSending(true);
    setFailed(false);
    try {
      await host.api.designs.sendMessage(designId, { text: text.trim() });
      setText("");
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FadeScroll className="flex-1">
        <div className="flex flex-col gap-3 px-1.5 py-3 text-13 leading-[1.5]">
          {items?.map((item) => (
            <ThreadLine key={item.id} item={item} />
          ))}
          <div ref={end} />
        </div>
      </FadeScroll>
      {writable ? (
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-end gap-2 rounded-14 bg-surface p-2 pl-3 shadow-bar">
            <textarea
              aria-label="Message Claude"
              placeholder="Reply to Claude"
              rows={1}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              className="max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1 text-13 text-ink outline-none [caret-color:var(--c-yuzu)] [field-sizing:content] placeholder:text-faint"
            />
            <SendButton size={28} iconSize={14} disabled={!canSend(text, sending)} onClick={send} />
          </div>
          {failed ? (
            <p role="alert" className="m-0 px-2 text-12 text-danger">
              That didn't send. Try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ThreadLine({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "message":
      return (
        <p className="m-0 self-end rounded-12 bg-surface px-3 py-2 text-ink">{item.payload.text}</p>
      );
    case "comment":
      return (
        <p className="m-0 text-muted">
          {item.payload.from.name} commented
          {item.payload.artboardName ? ` on ${item.payload.artboardName}` : ""}: “
          {item.payload.text}”
        </p>
      );
    case "assistant":
      return <p className="m-0 whitespace-pre-wrap text-ink">{item.payload.text}</p>;
    case "tool":
      return <p className="m-0 text-12 text-faint">{item.payload.label}</p>;
    case "notice":
      return <p className="m-0 text-12 text-faint">{noticeText(item.payload)}</p>;
  }
}

function noticeText(notice: Extract<ThreadItem, { kind: "notice" }>["payload"]): string {
  switch (notice.type) {
    case "waking":
      return "Waking up…";
    case "resumed":
    case "started":
      return "Claude is here.";
    case "question":
      return `${notice.header}: ${notice.text}`;
    case "error":
      return notice.message;
    case "stopped":
      return notice.by ? `${notice.by.name} stopped Claude.` : "Claude stopped.";
    case "pull_request":
      return `Pull request #${notice.number}: ${notice.title}`;
  }
}
