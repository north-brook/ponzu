import {
  Alert02Icon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import { memo, type ReactNode } from "react";
import type { Attachment, Person, Pin, PrState, ThreadItem, ThreadNotice } from "../model.ts";
import { Avatar } from "../ui/avatar.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { Slice } from "../ui/marks.tsx";
import { Prose } from "../ui/prose.tsx";
import { ERROR_COPY, ERROR_DETAIL, type ThreadRow, who } from "./thread.ts";

/** What a line can lead to: the canvas, the pull request tab, the browser. */
export interface LineHandlers {
  /** A miniature of a board, for a comment's frame; the canvas draws it. */
  renderBoard: (artboardId: string) => ReactNode;
  onOpenComment: (threadId: string) => void;
  onOpenArtboards: (artboardIds: string[]) => void;
  onOpenPullRequest: () => void;
  onOpenLink: (url: string) => void;
}

/**
 * One line of the thread. Memoized on its item and on its place in a run, each compared on its
 * own, so text streaming into the newest line redraws that line alone.
 */
export const ThreadLine = memo(function ThreadLine({
  item,
  continues,
  team,
  avatar,
  meId,
  handlers,
}: ThreadRow & { meId: string; handlers: LineHandlers }) {
  switch (item.kind) {
    case "message":
    case "comment":
      return (
        <PersonLine
          item={item}
          continues={continues}
          team={team}
          avatar={avatar}
          meId={meId}
          handlers={handlers}
        />
      );
    case "assistant":
      return (
        <div className="px-[2px] text-13 leading-[1.5]">
          <Prose text={item.payload.text} onOpenLink={handlers.onOpenLink} />
        </div>
      );
    case "tool":
      return <FoldedWork {...item.payload} onOpen={handlers.onOpenArtboards} />;
    case "notice":
      return <NoticeLine notice={item.payload} meId={meId} handlers={handlers} />;
  }
});

/**
 * A person's message, or their comment from the canvas: a bubble on the right, whoever sent it.
 * Images and a comment's board sit above it, as in Messages. With more than one person in the
 * thread, the sender's avatar is stamped on the last bubble of their run.
 */
function PersonLine({
  item,
  continues,
  team,
  avatar,
  meId,
  handlers,
}: Omit<ThreadRow, "item"> & {
  item: Extract<ThreadItem, { kind: "message" | "comment" }>;
  meId: string;
  handlers: LineHandlers;
}) {
  const { from, text } = item.payload;
  const above =
    item.kind === "message" ? (
      item.payload.attachments.length ? (
        <Attachments attachments={item.payload.attachments} onOpen={handlers.onOpenLink} />
      ) : null
    ) : item.payload.artboardId ? (
      <CommentFrame
        name={item.payload.artboardName}
        pin={item.payload.pin}
        onOpen={() => handlers.onOpenComment(item.payload.threadId)}
      >
        {handlers.renderBoard(item.payload.artboardId)}
      </CommentFrame>
    ) : null;
  return (
    <div
      className={cn(
        // What sits above a bubble hugs it; a team's bubbles leave room for the avatar above.
        "flex flex-col items-end self-end",
        team ? "gap-[9px]" : "gap-[5px]",
        // A run of one person's bubbles sits close; 14 between runs, from the thread's gap.
        continues && "-mt-2.5",
        // Room for the avatars on the bubbles' corners.
        team && "mr-2",
      )}
    >
      {above}
      <div className={cn("relative", team ? "max-w-[260px]" : "max-w-[280px]")}>
        <p
          dir="auto"
          className="m-0 whitespace-pre-wrap rounded-14 bg-surface px-[13px] py-[9px] text-13 leading-[1.5] [overflow-wrap:anywhere]"
        >
          <span className="sr-only">
            {who(from, meId)}
            {item.kind === "comment" ? " commented" : " said"}:{" "}
          </span>
          {text}
        </p>
        {avatar ? <Stamp person={from} /> : null}
      </div>
    </div>
  );
}

/** The sender's avatar on a bubble's corner, ringed in the rail's ground. */
function Stamp({ person }: { person: Person }) {
  return (
    <Avatar
      person={person}
      size={20}
      className="absolute -right-2 -bottom-[7px]"
      style={{ boxShadow: "0 0 0 2px var(--c-chrome)" }}
    />
  );
}

function Attachments({
  attachments,
  onOpen,
}: {
  attachments: Attachment[];
  onOpen: (url: string) => void;
}) {
  return (
    <div className="flex max-w-[280px] flex-wrap justify-end gap-1.5">
      {attachments.map((a) => (
        <button
          key={a.ref}
          type="button"
          aria-label={`Open ${a.ref.slice("assets/".length)}`}
          onClick={() => onOpen(a.url)}
          className="cursor-default overflow-hidden rounded-10 shadow-board outline-none focus-ring"
        >
          <img
            src={a.url}
            alt=""
            draggable={false}
            className={cn(
              "block bg-surface object-cover",
              // A fixed height, so nothing moves when the picture loads.
              attachments.length === 1
                ? "h-[160px] w-auto min-w-[88px] max-w-[220px]"
                : "size-[88px]",
            )}
          />
        </button>
      ))}
    </div>
  );
}

/** A miniature of the board a comment was pinned on, with a dot where the pin landed. */
function CommentFrame({
  name,
  pin,
  onOpen,
  children,
}: {
  name: string | null;
  pin: Pin | null;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={name ? `Open the comment on ${name}` : "Open the comment"}
      onClick={onOpen}
      // Left-aligned: the miniature is the board's, not a button label.
      className="relative h-[72px] w-[132px] cursor-default overflow-hidden rounded-6 bg-canvas text-left shadow-board outline-none transition-[filter] duration-(--dur-hover) focus-ring hover:brightness-[0.98]"
    >
      <span aria-hidden className="absolute inset-0">
        {children}
      </span>
      {pin ? (
        <span
          aria-hidden
          className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-pill bg-yuzu shadow-pin"
          style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
        />
      ) : null}
    </button>
  );
}

/**
 * A stretch of work, done: one quiet line named by what it did. When it touched boards, it
 * takes you to them.
 */
function FoldedWork({
  label,
  steps,
  artboards,
  onOpen,
}: {
  label: string;
  steps: number;
  artboards: string[];
  onOpen: (artboardIds: string[]) => void;
}) {
  const content = (
    <>
      <Slice size={11} className="text-dry" />
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-dry">·</span>
      <span className="shrink-0">
        {steps} {steps === 1 ? "step" : "steps"}
      </span>
    </>
  );
  const line = "flex min-w-0 items-center gap-1.5 px-[2px] text-12 text-faint leading-[1.4]";
  if (!artboards.length) return <div className={line}>{content}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpen(artboards)}
      className={cn(
        line,
        "-mx-1 -my-0.5 cursor-default self-start rounded-6 px-1.5 py-0.5 text-left outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover hover:text-muted",
      )}
    >
      {content}
    </button>
  );
}

const PR_ICON: Record<PrState, { icon: typeof GitPullRequestIcon; color: string; verb: string }> = {
  draft: { icon: GitPullRequestIcon, color: "text-icon-soft", verb: "opened as a draft" },
  open: { icon: GitPullRequestIcon, color: "text-pr-open", verb: "opened" },
  merged: { icon: GitMergeIcon, color: "text-pr-merged", verb: "merged" },
  closed: { icon: GitPullRequestClosedIcon, color: "text-muted", verb: "closed" },
};

/** What happened to the run that isn't anyone's words: quiet lines, an error in plain words. */
function NoticeLine({
  notice,
  meId,
  handlers,
}: {
  notice: ThreadNotice;
  meId: string;
  handlers: LineHandlers;
}) {
  const quiet = "flex min-w-0 items-center gap-2 px-[2px] text-12 text-faint leading-[1.4]";
  switch (notice.type) {
    case "error":
      return (
        <div role="note" className="flex gap-2 px-[2px] text-13 leading-[1.5]">
          <Icon icon={Alert02Icon} size={14} stroke={1.9} className="mt-[3px] text-danger" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span>{ERROR_COPY[notice.code]}</span>
            {ERROR_DETAIL.has(notice.code) && notice.message ? (
              <span className="line-clamp-3 text-12 text-faint [overflow-wrap:anywhere]">
                {notice.message}
              </span>
            ) : null}
          </div>
        </div>
      );
    case "stopped":
      return (
        <div className={quiet}>
          <span aria-hidden className="size-[7px] shrink-0 rounded-2 bg-dry" />
          {notice.by ? `${who(notice.by, meId)} stopped it` : "Stopped"}
        </div>
      );
    case "question":
      return (
        <div className={quiet} title={notice.text}>
          <span aria-hidden className="size-[7px] shrink-0 rounded-pill bg-dry" />
          <span className="shrink-0">Asked:</span>
          <span className="truncate">{notice.text}</span>
        </div>
      );
    case "pull_request": {
      const { icon, color, verb } = PR_ICON[notice.state];
      return (
        <button
          type="button"
          onClick={handlers.onOpenPullRequest}
          className={cn(
            quiet,
            "-mx-1 -my-0.5 cursor-default self-start rounded-6 px-1.5 py-0.5 text-left text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover",
          )}
        >
          <Icon icon={icon} size={12} stroke={2} className={color} />
          <span className="shrink-0">
            Pull request <span className="font-mono text-11">#{notice.number}</span> {verb}
          </span>
          <span className="truncate text-faint">{notice.title}</span>
        </button>
      );
    }
    default:
      return null;
  }
}

/** The thread's newest line while the agent works: the turning slice and what it's doing. */
export function WorkingLine({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="flex min-w-0 items-center gap-2 px-[2px] text-13 text-muted leading-[1.4]"
    >
      <Slice size={15} turning className="text-yuzu" label="Working" />
      <span className="truncate">{label}</span>
    </div>
  );
}
