import {
  Alert02Icon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import { memo, type ReactNode, useState } from "react";
import type {
  AgentPrAction,
  Attachment,
  Person,
  PrState,
  ThreadItem,
  ThreadNotice,
} from "../model.ts";
import { Avatar } from "../ui/avatar.tsx";
import { cn } from "../ui/cn.ts";
import { useColorScheme } from "../ui/color-scheme.ts";
import { Icon } from "../ui/icon.tsx";
import { Slice } from "../ui/marks.tsx";
import { Prose } from "../ui/prose.tsx";
import {
  ERROR_COPY,
  ERROR_DETAIL,
  modelChangedLine,
  ownerChangedLine,
  type ThreadRow,
  who,
} from "./thread.ts";

/** What a line can lead to: the canvas, the pull request tab, the browser. */
export interface LineHandlers {
  /**
   * What stands in for the picture of where the viewer's own comment was left while their app
   * is still making its files (the canvas gives its ground, never a live copy of the boards).
   */
  renderDrawing: (messageId: string) => ReactNode;
  /** Takes the canvas to a comment: its page, its pin in the middle, its thread open. */
  onOpenComment: (threadId: string, messageId: string) => void;
  onOpenArtboards: (artboardIds: string[]) => void;
  onOpenPullRequest: () => void;
  onOpenLink: (url: string) => void;
  /** Sends a message that didn't arrive again. */
  onRetryMessage?: (id: string) => void;
  /** Takes a message that didn't arrive back into the composer. */
  onEditMessage?: (id: string) => void;
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
  aside = false,
  asideContinues = false,
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
        <div
          // The rail notes where an aside sits, so it can close its room once the turn ends.
          data-aside={aside ? item.id : undefined}
          // What the rail finds a line by, to bring it into view (ThreadView's `reveal`).
          data-item={item.id}
          className={cn(
            "px-[2px] text-13 leading-[1.5]",
            // Said on the way to the answer: quieter, in italics, a run of them close together
            // (the thread's 14 between lines, less 8). Its bold stays as quiet as its words, its
            // code upright (the mono face has no italic); a link keeps its ink, to read as one.
            aside && "text-muted italic [&_code]:not-italic [&_strong]:[color:inherit]",
            asideContinues && "-mt-2",
          )}
        >
          <Prose
            text={item.payload.text}
            streaming={item.streaming}
            onOpenLink={handlers.onOpenLink}
          />
        </div>
      );
    case "tool":
      // The agent's work is never a line of its own: while a turn runs it is the working line,
      // and once it ends only what the agent said is kept.
      return null;
    case "notice":
      return <NoticeLine notice={item.payload} meId={meId} handlers={handlers} />;
  }
});

/**
 * A person's message, or their comment from the canvas: a bubble on the right, whoever sent it.
 * Images sit above a message, as in Messages. A comment is a picture of where it was left with
 * its words under it, one unit like a photo sent with a text, or, without a picture, a quiet
 * line above its words that says where. With more than one person in the thread, the sender's
 * avatar is stamped on the last bubble of their run.
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
  const delivery = item.kind === "message" ? item.payload.delivery : undefined;
  const theme = useColorScheme();
  // A picture that wouldn't load (gone from storage, or offline) gives way to the line.
  const [failed, setFailed] = useState<string | null>(null);
  const comment = item.kind === "comment" ? item.payload : null;
  const src = comment?.picture?.kind === "image" ? comment.picture[theme] : undefined;
  const picture =
    comment?.picture && (src === undefined || src !== failed) ? comment.picture : null;
  const openComment = comment
    ? () => handlers.onOpenComment(comment.threadId, comment.messageId)
    : undefined;
  const above =
    item.kind === "message" ? (
      item.payload.attachments.length ? (
        <Attachments attachments={item.payload.attachments} onOpen={handlers.onOpenLink} />
      ) : null
    ) : comment && openComment && picture ? (
      <CommentPictureButton
        src={src}
        width={picture.width}
        height={picture.height}
        place={placeOf(comment)}
        onOpen={openComment}
        onFailed={() => setFailed(src ?? null)}
      >
        {picture.kind === "drawing" ? handlers.renderDrawing(comment.messageId) : null}
      </CommentPictureButton>
    ) : comment && openComment ? (
      <CommentPlace place={placeOf(comment)} onOpen={openComment} />
    ) : null;
  return (
    <div
      data-item={item.id}
      className={cn(
        // What sits above a bubble hugs it; a team's bubbles leave room for the avatar above.
        "flex flex-col items-end self-end",
        // A comment's picture and its words are one: they meet with a hairline of a gap.
        picture ? "gap-[2px]" : team ? "gap-[9px]" : "gap-[5px]",
        // A run of one person's bubbles sits close; 14 between runs, from the thread's gap. A
        // picture and its words are a unit of their own in the run, so it keeps a little more.
        continues && (picture ? "-mt-1.5" : "-mt-2.5"),
        // Room for the avatars on the bubbles' corners.
        team && "mr-2",
      )}
    >
      {above}
      <div className={cn("relative", team ? "max-w-[260px]" : "max-w-[280px]")}>
        <p
          dir="auto"
          aria-busy={delivery === "sending" || undefined}
          className={cn(
            "m-0 whitespace-pre-wrap rounded-14 bg-surface px-[13px] py-[9px] text-13 leading-[1.5] transition-opacity duration-(--dur-hover) [overflow-wrap:anywhere]",
            // Where it meets its picture, the corner on the sender's side tucks in, as the
            // bubbles of one run do in Messages.
            picture && "rounded-tr-[5px]",
            delivery && "opacity-60",
          )}
        >
          <span className="sr-only">
            {who(from, meId)}
            {item.kind === "comment" ? " commented" : " said"}:{" "}
          </span>
          {text}
        </p>
        {avatar ? <Stamp person={from} /> : null}
      </div>
      {item.kind === "message" && item.payload.via ? (
        <span className="text-11 text-faint">via {item.payload.via}</span>
      ) : null}
      {delivery === "failed" ? <Undelivered id={item.id} handlers={handlers} /> : null}
    </div>
  );
}

/** Under a message that didn't arrive: say so, and send it again or take it back to edit. */
function Undelivered({ id, handlers }: { id: string; handlers: LineHandlers }) {
  const action =
    "cursor-default rounded-4 px-1 font-medium text-ink outline-none focus-ring hover:underline";
  return (
    <div role="alert" className="flex items-center gap-1.5 text-12 text-faint leading-[1.4]">
      <Icon icon={Alert02Icon} step="small" className="text-danger" />
      <span>Didn't send.</span>
      {handlers.onRetryMessage ? (
        <button type="button" onClick={() => handlers.onRetryMessage?.(id)} className={action}>
          Try again
        </button>
      ) : null}
      {handlers.onEditMessage ? (
        <button type="button" onClick={() => handlers.onEditMessage?.(id)} className={action}>
          Edit
        </button>
      ) : null}
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

/** Where a comment was left, in words: its board, or the ground (and its page). */
function placeOf(comment: Extract<ThreadItem, { kind: "comment" }>["payload"]): string {
  if (comment.artboardName) return comment.artboardName;
  if (comment.artboardId) return "a board";
  return comment.pageName ? `the canvas, ${comment.pageName}` : "the canvas";
}

/**
 * How wide a comment's picture is shown: a glance at where the comment was left, not the message
 * itself, so its words lead. Three fifths of the size it is drawn at (240 by 160, at 2x: twice
 * the pixels a 2x screen needs at this size, so it stays sharp), the same at every width of the
 * rail.
 */
export const COMMENT_PICTURE_WIDTH = 144;
/** A tall picture is cut to this height (from its middle, where its pin is), not shown taller. */
export const COMMENT_PICTURE_MAX_HEIGHT = 108;

/** The size a picture drawn at `width` by `height` is shown at in the thread. */
export function commentPictureSize(width: number, height: number) {
  const shownWidth = Math.min(COMMENT_PICTURE_WIDTH, width);
  return {
    width: shownWidth,
    height: Math.min(COMMENT_PICTURE_MAX_HEIGHT, Math.round((shownWidth * height) / width)),
  };
}

/**
 * The picture of where a comment was left, above its words as a photo sits above the text sent
 * with it in Messages: the corner that meets the bubble tucked in to the bubble's own (5), the
 * others a step under the bubble's 14 as its smaller size wants. It holds its size from the
 * first frame, on the canvas's ground, and the image comes up over it once it has loaded.
 * Pressing it takes the canvas there.
 */
function CommentPictureButton({
  src,
  width,
  height,
  place,
  onOpen,
  onFailed,
  children,
}: {
  /** The file for the theme shown; none while it is being drawn (`children` is the scene). */
  src: string | undefined;
  width: number;
  height: number;
  place: string;
  onOpen: () => void;
  onFailed: () => void;
  children: ReactNode;
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const shown = commentPictureSize(width, height);
  return (
    <button
      type="button"
      aria-label={`Open the comment on ${place}`}
      onClick={onOpen}
      style={shown}
      className="relative block shrink-0 cursor-default overflow-hidden rounded-10 rounded-br-[5px] bg-canvas shadow-board outline-none transition-[filter] duration-(--dur-hover) focus-ring hover:brightness-[0.97] active:brightness-[0.94]"
    >
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          // The picture's own pixels are its ground's: nothing shows until they are in.
          onLoad={() => setLoaded(src)}
          onError={onFailed}
          className={cn(
            "block size-full object-cover transition-opacity duration-(--dur-hover)",
            loaded === src ? "opacity-100" : "opacity-0",
          )}
        />
      ) : (
        <span aria-hidden className="absolute inset-0">
          {children}
        </span>
      )}
    </button>
  );
}

/**
 * A comment with no picture to show (from before there were pictures, too large to keep, or one
 * that wouldn't load): a quiet line above its words that says where it was left, and goes there.
 */
function CommentPlace({ place, onOpen }: { place: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Open the comment on ${place}`}
      onClick={onOpen}
      className="-my-0.5 -mr-1 flex min-w-0 max-w-[280px] cursor-default items-center gap-1.5 rounded-6 px-1.5 py-0.5 text-12 text-faint leading-[1.4] outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover hover:text-muted"
    >
      <span aria-hidden className="size-2 shrink-0 rounded-pill bg-yuzu shadow-pin" />
      <span className="truncate">On {place}</span>
    </button>
  );
}

const PR_ICON: Record<PrState, { icon: typeof GitPullRequestIcon; color: string; verb: string }> = {
  draft: { icon: GitPullRequestIcon, color: "text-icon-soft", verb: "opened as a draft" },
  open: { icon: GitPullRequestIcon, color: "text-pr-open", verb: "opened" },
  merged: { icon: GitMergeIcon, color: "text-pr-merged", verb: "merged" },
  closed: { icon: GitPullRequestClosedIcon, color: "text-muted", verb: "closed" },
};

/** The agent's own pull request lines: what it did, in the words the line says it with. */
const AGENT_PR: Record<
  AgentPrAction,
  { icon: typeof GitPullRequestIcon; color: string; verb: string }
> = {
  opened: { icon: GitPullRequestIcon, color: "text-pr-open", verb: "opened" },
  ready: { icon: GitPullRequestIcon, color: "text-pr-open", verb: "marked ready" },
  updated_branch: {
    icon: GitPullRequestIcon,
    color: "text-icon-soft",
    verb: "updated the branch of",
  },
  auto_merge: { icon: GitMergeIcon, color: "text-icon-soft", verb: "turned on auto-merge for" },
  merged: { icon: GitMergeIcon, color: "text-pr-merged", verb: "merged" },
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
          <Icon icon={Alert02Icon} step="inline" className="mt-[3px] text-danger" />
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
          {notice.answer ? (
            <>
              <span aria-hidden className="shrink-0">
                →
              </span>
              <span className="sr-only">answered</span>
              <span className="max-w-[45%] shrink-0 truncate text-ink">{notice.answer}</span>
            </>
          ) : null}
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
            // No wider than the rail, so a long title ends in an ellipsis.
            "-mx-1 -my-0.5 min-w-0 max-w-full cursor-default self-start rounded-6 px-1.5 py-0.5 text-left text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover",
          )}
        >
          <Icon icon={icon} step="small" className={color} />
          <span className="shrink-0">
            {notice.repository ? "Linked pull request" : "Pull request"}{" "}
            <span className="font-mono text-11">
              {notice.repository ?? ""}#{notice.number}
            </span>{" "}
            {verb}
          </span>
          <span className="truncate text-faint">{notice.title}</span>
        </button>
      );
    }
    case "pull_request_linked": {
      const { icon, color } = PR_ICON[notice.state];
      return (
        <button
          type="button"
          onClick={handlers.onOpenPullRequest}
          className={cn(
            quiet,
            "-mx-1 -my-0.5 min-w-0 max-w-full cursor-default self-start rounded-6 px-1.5 py-0.5 text-left text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover",
          )}
        >
          <Icon icon={icon} step="small" className={color} />
          <span className="shrink-0">
            Linked{" "}
            <span className="font-mono text-11">
              {notice.repository}#{notice.number}
            </span>
            {notice.via ? ` via ${notice.via}` : ""}
          </span>
          <span className="truncate text-faint">{notice.title}</span>
        </button>
      );
    }
    case "pull_request_agent": {
      const { icon, color, verb } = AGENT_PR[notice.action];
      const as = notice.as ? (notice.as.id === meId ? "you" : who(notice.as, meId)) : null;
      const said =
        notice.action === "ready" ? (
          <>
            Claude marked <span className="font-mono text-11">#{notice.number}</span> ready
          </>
        ) : (
          <>
            Claude {verb} <span className="font-mono text-11">#{notice.number}</span>
          </>
        );
      return (
        <button
          type="button"
          onClick={handlers.onOpenPullRequest}
          className={cn(
            quiet,
            "-mx-1 -my-0.5 min-w-0 max-w-full cursor-default self-start rounded-6 px-1.5 py-0.5 text-left text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover",
          )}
        >
          <Icon icon={icon} step="small" className={color} />
          <span className="shrink-0">
            {said}
            {as ? ` as ${as}` : ""}
          </span>
          <span className="truncate text-faint">{notice.title}</span>
        </button>
      );
    }
    case "owner_changed":
      return (
        <div className={quiet}>
          <span aria-hidden className="size-[7px] shrink-0 rounded-pill bg-dry" />
          <span className="min-w-0">{ownerChangedLine(notice.by, meId)}</span>
        </div>
      );
    case "model_changed":
      // A sentence, not a label: it wraps, its mark beside its first line.
      return (
        <div
          role="note"
          className="flex min-w-0 items-start gap-2 px-[2px] text-12 text-faint leading-[1.4]"
        >
          <span aria-hidden className="mt-[5px] size-[7px] shrink-0 rounded-pill bg-dry" />
          <span className="min-w-0">{modelChangedLine(notice, meId)}</span>
        </div>
      );
    default:
      return null;
  }
}

/**
 * The thread's newest line while the canvas's sandbox can't run: a quiet still slice while it
 * waits its turn for a machine, or the error mark when starting one failed.
 */
export function SandboxLine({ text, failed }: { text: string; failed: boolean }) {
  return (
    <div
      role="status"
      className="flex min-w-0 items-start gap-2 px-[2px] text-12 text-faint leading-[1.4]"
    >
      {failed ? (
        <Icon icon={Alert02Icon} step="small" className="mt-[1px] text-danger" />
      ) : (
        <Slice size={13} className="mt-[1px] text-dry" />
      )}
      <span>{text}</span>
    </div>
  );
}

/**
 * The thread's newest line while the agent works: the turning slice and what it's doing. Each
 * new state settles in where the last one was; the slice keeps turning through them. `leaving`
 * is its last frame, drawn while its room closes: no longer a status, nothing to announce.
 */
export function WorkingLine({ label, leaving = false }: { label: string; leaving?: boolean }) {
  return (
    <div
      role={leaving ? undefined : "status"}
      data-working-line={leaving ? undefined : ""}
      className="flex min-w-0 items-center gap-2 px-[2px] text-13 text-muted leading-[1.4]"
    >
      <Slice size={15} turning className="text-yuzu" label="Working" />
      <span key={label} className={cn("truncate", !leaving && "settle")}>
        {label}
      </span>
    </div>
  );
}
