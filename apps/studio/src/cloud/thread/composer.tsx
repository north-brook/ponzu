import { Add01Icon, Cancel01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useRef, useState } from "react";
import { gateMessage } from "../gate.ts";
import type { PendingAttachment, SteerGate } from "../model.ts";
import { Button, IconButton, SendButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { AgentMark } from "../ui/marks.tsx";
import { Tip } from "../ui/tooltip.tsx";
import { composerButton } from "./composer-rules.ts";

const images = (files: FileList | null | undefined) =>
  [...(files ?? [])].filter((f) => f.type.startsWith("image/"));

/**
 * The rail's composer: attach, the field, and one round button that is Stop while the agent
 * works with nothing typed, and Send otherwise (composerButton). Return sends and Shift-Return
 * breaks the line; the field grows to six lines, then scrolls. Images come in by the "+", a
 * paste or a drop. While the run waits on its owner's Claude a strip above the field says so
 * and nothing sends; typing still keeps a draft.
 */
export function RailComposer({
  text,
  onTextChange,
  working,
  gate,
  meId,
  attachments,
  onAttach,
  onRemoveAttachment,
  onRetryAttachment,
  onSend,
  onStop,
  onConnectClaude,
}: {
  text: string;
  onTextChange: (text: string) => void;
  working: boolean;
  /** A wait on the owner's Claude; read-only access has no composer at all. */
  gate: Extract<SteerGate, { kind: "claude_limit" | "claude_disconnected" }> | null;
  meId: string;
  attachments: PendingAttachment[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Offered when the wait is the viewer's own Claude, disconnected. */
  onConnectClaude?: () => void;
}) {
  const button = composerButton({ working, text, attachments, gate });
  const picker = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (button === "send") onSend();
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = images(e.clipboardData.files);
    if (!files.length || gate) return;
    e.preventDefault();
    onAttach(files);
  };
  const onDragOver = (e: DragEvent) => {
    if (gate || ![...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) return;
    e.preventDefault();
    setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    setDropping(false);
    const files = images(e.dataTransfer.files);
    if (!files.length || gate) return;
    e.preventDefault();
    onAttach(files);
  };

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden rounded-16 bg-surface shadow-bar transition-shadow duration-(--dur-hover)",
        dropping && "shadow-focus",
      )}
    >
      {gate ? (
        <div className="flex items-center gap-2.5 border-rule border-b bg-strip py-[11px] pr-3 pl-[18px] text-13 leading-[1.4]">
          <span className="flex shrink-0" aria-hidden>
            <AgentMark client="claude" size={13} />
          </span>
          <span role="status" className="min-w-0 flex-1">
            {gateMessage(gate, meId)}
          </span>
          {gate.kind === "claude_disconnected" && gate.owner.id === meId && onConnectClaude ? (
            <Button variant="quiet" onClick={onConnectClaude} className="-my-1 px-2 text-ink">
              Connect
            </Button>
          ) : null}
        </div>
      ) : null}
      {attachments.length ? (
        <ul aria-label="Attached images" className="m-0 flex list-none flex-wrap gap-1.5 px-3 pt-3">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() => onRemoveAttachment(a.id)}
              onRetry={() => onRetryAttachment(a.id)}
            />
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-[2px] py-2 pr-2 pl-1.5">
        <IconButton
          label="Attach an image"
          tipSide="top"
          disabled={gate !== null}
          onClick={() => picker.current?.click()}
          className="size-7 rounded-pill text-icon-soft"
        >
          <Icon icon={Add01Icon} size={16} stroke={1.8} />
        </IconButton>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = images(e.currentTarget.files);
            if (files.length) onAttach(files);
            e.currentTarget.value = "";
          }}
        />
        <textarea
          aria-label="Message"
          placeholder="Steer, or ask more"
          rows={1}
          dir="auto"
          value={text}
          onChange={(e) => onTextChange(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-[128px] min-w-0 flex-1 resize-none bg-transparent py-1 text-13 text-ink leading-5 outline-none [caret-color:var(--c-ink)] [field-sizing:content] [scrollbar-width:thin] placeholder:text-faint"
        />
        {button === "stop" ? (
          <StopButton onStop={onStop} />
        ) : (
          <SendButton size={28} iconSize={13} disabled={button === "waiting"} onClick={onSend} />
        )}
      </div>
    </div>
  );
}

/** Ink, with a paper square: stops the run. */
export function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <Tip label="Stop" side="top">
      <button
        type="button"
        aria-label="Stop"
        onClick={onStop}
        className="app-no-drag grid size-7 shrink-0 cursor-default place-items-center rounded-pill bg-action outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-action-hover active:bg-action-press"
      >
        <span className="size-[9px] rounded-2 bg-action-ink" />
      </button>
    </Tip>
  );
}

/** An image on its way: its picture, breathing while it uploads, with a way to take it back. */
function AttachmentChip({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: PendingAttachment;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const failed = attachment.status === "failed";
  return (
    <li className="group relative">
      <img
        src={attachment.previewUrl}
        alt={attachment.name}
        draggable={false}
        className={cn(
          "block size-11 rounded-8 bg-chip object-cover shadow-board",
          attachment.status === "uploading" && "breathe",
          failed && "opacity-40",
        )}
      />
      {failed ? (
        <button
          type="button"
          aria-label={`Try ${attachment.name} again`}
          onClick={onRetry}
          className="absolute inset-0 grid cursor-default place-items-center rounded-8 text-danger outline-none focus-ring"
        >
          <Icon icon={RefreshIcon} size={16} stroke={2} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 grid size-[18px] cursor-default place-items-center rounded-pill bg-action text-action-ink opacity-0 shadow-[0_0_0_2px_var(--c-surface)] outline-none transition-opacity duration-(--dur-hover) focus-ring focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={Cancel01Icon} size={10} stroke={2.6} />
      </button>
    </li>
  );
}

/** Someone who can read the design but not steer it: one line where the composer would be. */
export function ReadOnlyLine({ message }: { message: string }) {
  return (
    <p className="m-0 shrink-0 px-3 py-2.5 text-center text-12 text-faint leading-[1.5]">
      {message}
    </p>
  );
}
