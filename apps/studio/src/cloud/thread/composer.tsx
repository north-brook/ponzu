import { Cancel01Icon, PlusSignIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  memo,
  useRef,
  useState,
} from "react";
import { blockerWords, gateMessage } from "../gate.ts";
import type { PendingAttachment, SteerGate } from "../model.ts";
import { Button, IconButton, SendButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { AgentMark } from "../ui/marks.tsx";
import { FIELD, PRESS_OWN, pressToFocus } from "../ui/press-to-focus.ts";
import { Tip } from "../ui/tooltip.tsx";
import { composerButton, composerHolds } from "./composer-rules.ts";

const images = (files: FileList | null | undefined) =>
  [...(files ?? [])].filter((f) => f.type.startsWith("image/"));

/**
 * The rail's composer: attach, the field, and one round button that is Stop while the agent
 * works with nothing typed, and Send otherwise (composerButton). Return sends and Shift-Return
 * breaks the line; the field grows to six lines, then scrolls. Images come in by the "+", a
 * paste or a drop. While the run waits on its owner's Claude a strip above the field says so
 * and nothing sends; typing still keeps a draft. A plan at its limit is the one wait that still
 * takes a message: the strip says it goes in when the plan resets. Once its owner has left the
 * workspace nothing runs it until a teammate takes it over, so the strip is all there is, with
 * "Take over" for someone who can: no field to write in for nobody. Memoized: the rail hands it
 * the same handlers every time, so the thread moving on doesn't draw it again.
 */
export const RailComposer = memo(function RailComposer({
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
  onTakeOver,
  takingOver = false,
}: {
  text: string;
  onTextChange: (text: string) => void;
  working: boolean;
  /** A wait on the owner's Claude; read-only access has no composer at all. */
  gate: Exclude<SteerGate, { kind: "read_only" }> | null;
  meId: string;
  attachments: PendingAttachment[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Offered when the wait is the viewer's own Claude, disconnected or run out. */
  onConnectClaude?: () => void;
  /**
   * Takes over a canvas whose owner left, onto the viewer's Claude: offered when they can
   * (`canTakeOver`). Once it is theirs the gate goes, and the field with it comes back.
   */
  onTakeOver?: () => void;
  /** A take-over is on its way: the button waits for it. */
  takingOver?: boolean;
}) {
  const button = composerButton({ working, text, attachments, gate });
  const ended = gate?.kind === "claude_owner_left";
  const holds = composerHolds(gate);
  const queued =
    gate?.kind === "claude_limit"
      ? blockerWords({ blocker: "claude_limited", owner: gate.owner, meId, until: gate.until })
          .queued
      : null;
  const picker = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (button === "send") onSend();
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = images(e.clipboardData.files);
    if (!files.length || holds) return;
    e.preventDefault();
    onAttach(files);
  };
  const onDragOver = (e: DragEvent) => {
    if (holds || ![...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) return;
    e.preventDefault();
    setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    setDropping(false);
    const files = images(e.dataTransfer.files);
    if (!files.length || holds) return;
    e.preventDefault();
    onAttach(files);
  };

  return (
    // The whole card is the field's: a press on it, past its controls, writes.
    <div
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      onMouseDown={pressToFocus}
      data-composer-card
      className={cn(
        "flex shrink-0 flex-col overflow-hidden rounded-16 bg-surface shadow-bar transition-shadow duration-(--dur-hover)",
        !ended && "cursor-text",
        dropping && "shadow-focus",
      )}
    >
      {gate ? (
        // The gate's words are a status, not part of the field: they keep the arrow and their
        // own presses, so they can be selected and copied.
        <div
          {...PRESS_OWN}
          className={cn(
            "flex cursor-default items-center gap-2.5 bg-strip py-[11px] pr-3 pl-[18px] text-13 leading-[1.4]",
            !ended && "border-rule border-b",
          )}
        >
          <span className="flex shrink-0" aria-hidden>
            <AgentMark client="claude" size={13} />
          </span>
          <span role="status" className="min-w-0 flex-1">
            {gateMessage(gate, meId)}
            {queued ? <span className="block text-muted">{queued}</span> : null}
          </span>
          {(gate.kind === "claude_disconnected" || gate.kind === "claude_expired") &&
          gate.owner.id === meId &&
          onConnectClaude ? (
            <Button variant="quiet" onClick={onConnectClaude} className="-my-1 px-2 text-ink">
              Connect
            </Button>
          ) : null}
          {gate.kind === "claude_owner_left" && gate.canTakeOver && onTakeOver ? (
            <Button
              variant="quiet"
              onClick={onTakeOver}
              disabled={takingOver}
              className="-my-1 px-2 text-ink"
            >
              Take over
            </Button>
          ) : null}
        </div>
      ) : null}
      {ended ? null : attachments.length ? (
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
      <div className={cn("flex items-end gap-[2px] py-2 pr-2 pl-1.5", ended && "hidden")}>
        <IconButton
          label="Attach an image"
          tipSide="top"
          data-composer-attach
          disabled={holds}
          onClick={() => picker.current?.click()}
          className="size-7 rounded-pill"
        >
          <Icon icon={PlusSignIcon} step="control" />
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
          {...FIELD}
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
          <SendButton
            size={28}
            disabled={button === "waiting"}
            onClick={onSend}
            data-composer-send
          />
        )}
      </div>
    </div>
  );
});

/** Ink, with a paper square: stops the run. */
export function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <Tip label="Stop" side="top">
      <button
        type="button"
        aria-label="Stop"
        data-composer-send
        onClick={onStop}
        className="app-no-drag grid size-7 shrink-0 cursor-default place-items-center rounded-pill bg-action outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-action-hover active:bg-action-press"
      >
        <span className="size-[9px] rounded-2 bg-action-ink" />
      </button>
    </Tip>
  );
}

/** An image on its way: its picture, breathing while it uploads, with a way to take it back. */
export function AttachmentChip({
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
          <Icon icon={RefreshIcon} step="control" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 grid size-[18px] cursor-default place-items-center rounded-pill bg-action text-action-ink opacity-0 shadow-[0_0_0_2px_var(--c-surface)] outline-none transition-opacity duration-(--dur-hover) focus-ring focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={Cancel01Icon} step="tick" onFill />
      </button>
    </li>
  );
}

/**
 * Someone who can read the canvas but not steer it: one line where the composer would be. The
 * repo's name, when the line has one, wraps whole rather than at its hyphen or slash.
 */
export function ReadOnlyLine({ message, whole }: { message: string; whole?: string | null }) {
  const at = whole ? message.indexOf(whole) : -1;
  return (
    <p className="m-0 shrink-0 px-3 py-2.5 text-center text-12 text-faint leading-[1.5]">
      {whole && at >= 0 ? (
        <>
          {message.slice(0, at)}
          <span className="whitespace-nowrap">{whole}</span>
          {message.slice(at + whole.length)}
        </>
      ) : (
        message
      )}
    </p>
  );
}
