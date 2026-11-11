import {
  Cancel01Icon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LinkSquare02Icon,
  MinusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import type {
  CheckRun,
  GithubAuthor,
  PrComment,
  PrDiff,
  PrReview,
  PrState,
  PullRequestDetail,
  PullRequestSummary,
} from "../model.ts";
import { ago, duration, useNow } from "../time.ts";
import { Avatar } from "../ui/avatar.tsx";
import { Button, IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon, type IconSvgElement } from "../ui/icon.tsx";
import { safeHref } from "../ui/markdown.ts";
import { AgentMark } from "../ui/marks.tsx";
import { Prose } from "../ui/prose.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { orderChecks } from "./diff.ts";
import { Files } from "./files.tsx";

/** The tab's content: the pull request, or the moments before it arrives or when it can't. */
export type PullRequestTabState =
  | { kind: "loading"; summary: PullRequestSummary }
  | { kind: "error"; summary: PullRequestSummary }
  | { kind: "ready"; pr: PullRequestDetail };

const STATE_ICON: Record<PrState, { icon: IconSvgElement; color: string }> = {
  draft: { icon: GitPullRequestIcon, color: "text-icon-soft" },
  open: { icon: GitPullRequestIcon, color: "text-pr-open" },
  merged: { icon: GitMergeIcon, color: "text-pr-merged" },
  closed: { icon: GitPullRequestClosedIcon, color: "text-muted" },
};

/**
 * The pull request tab, in the canvas's pane: what it is, whether it is green, what people said
 * and what changed. Details, checks, comments and approvals in a 380 column, each scrolling on
 * its own beside the diffs, which take the rest. Read-only: replying is GitHub's, or the agent's
 * when asked in the thread. Sections with nothing in them are left out.
 */
export function PullRequestView({
  state,
  viewerLogin,
  onOpenLink: open,
  onRetry,
  onLoadDiff,
}: {
  state: PullRequestTabState;
  viewerLogin: string;
  onOpenLink: (url: string) => void;
  onRetry: () => void;
  /** Fetches a file's diff when its card first opens. */
  onLoadDiff?: (path: string) => Promise<PrDiff>;
}) {
  // GitHub's addresses (a check's page, a link in a comment) leave the app only to the web.
  const onOpenLink = (url: string) => {
    const href = safeHref(url);
    if (href) open(href);
  };
  const column = "flex min-h-0 min-w-0 flex-col overflow-y-auto pt-11 pb-11 [scrollbar-width:thin]";
  if (state.kind !== "ready") {
    return (
      <div className="absolute inset-0 grid grid-cols-[380px_minmax(0,1fr)] gap-12 pr-12 pl-14">
        <div className={cn(column, "gap-[26px]")}>
          <div className="flex flex-col gap-3.5">
            <Skeleton className="h-[29px] w-4/5 rounded-6" />
            <Subtitle state={state.summary.state} number={state.summary.number} />
          </div>
          {state.kind === "error" ? (
            <div role="alert" className="flex items-center gap-2 text-13 text-muted">
              Couldn't reach GitHub.
              <Button variant="quiet" onClick={onRetry} className="-my-1 px-2 text-ink">
                Try again
              </Button>
            </div>
          ) : (
            <DetailsSkeleton rows={6} />
          )}
        </div>
        <div className={cn(column, "gap-2.5")} aria-hidden>
          <Skeleton className="h-3.5 w-12 rounded-3" />
          {[0, 1, 2].map((i) => (
            <Skeleton
              key={i}
              className="h-9 rounded-10 bg-surface shadow-file-card"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          ))}
        </div>
      </div>
    );
  }

  const { pr } = state;
  return (
    <div className="absolute inset-0 grid grid-cols-[380px_minmax(0,1fr)] gap-12 pr-12 pl-14">
      <div className={cn(column, "gap-[26px]")}>
        <div className="flex flex-col gap-3.5">
          <h1 className="m-0 font-display font-semibold text-26 leading-[1.1] tracking-[-0.02em] [overflow-wrap:anywhere]">
            {pr.title}
          </h1>
          <Subtitle
            state={pr.state}
            number={pr.number}
            branches={`${pr.head} → ${pr.base}`}
            endedAt={pr.endedAt}
            onOpen={() => onOpenLink(pr.url)}
          />
          {pr.body.trim() ? (
            <Prose
              text={pr.body}
              onOpenLink={onOpenLink}
              className="text-13 text-muted leading-[1.6]"
            />
          ) : null}
        </div>
        {pr.checks.length ? (
          <Section title="Checks">
            {orderChecks(pr.checks).map((check) => (
              <CheckRow key={check.id} check={check} onOpenLink={onOpenLink} />
            ))}
          </Section>
        ) : null}
        {pr.comments.length ? (
          <Section title="Comments" gap>
            {pr.comments.map((comment) => (
              <Comment
                key={comment.id}
                comment={comment}
                viewerLogin={viewerLogin}
                onOpenLink={onOpenLink}
              />
            ))}
          </Section>
        ) : null}
        {pr.reviews.length ? (
          <Section title="Approvals">
            {pr.reviews.map((review) => (
              <ReviewRow key={review.id} review={review} viewerLogin={viewerLogin} />
            ))}
          </Section>
        ) : null}
      </div>
      <div className={column}>
        <Files
          files={pr.files}
          additions={pr.additions}
          deletions={pr.deletions}
          url={pr.url}
          onOpenLink={onOpenLink}
          onLoadDiff={onLoadDiff}
        />
      </div>
    </div>
  );
}

/** "#412 ↗ · pz/hero-refresh → main", and for one that isn't open, what became of it. */
function Subtitle({
  state,
  number,
  branches,
  endedAt,
  onOpen,
}: {
  state: PrState;
  number: number;
  branches?: string;
  endedAt?: string | null;
  onOpen?: () => void;
}) {
  const now = useNow();
  const { icon, color } = STATE_ICON[state];
  const ended =
    state === "draft"
      ? "Draft"
      : state === "merged"
        ? `Merged${endedAt ? ` ${ago(endedAt, now, "long")}` : ""}`
        : state === "closed"
          ? "Closed"
          : null;
  const dot = <span className="text-dry">·</span>;
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-12 text-muted">
      <span className="flex shrink-0 items-center gap-1">
        <Icon icon={icon} size={12} stroke={2} className={color} />#{number}
        {onOpen ? (
          <IconButton
            label="Open on GitHub"
            onClick={onOpen}
            className="-m-1 size-[19px] rounded-5 text-faint"
          >
            <Icon icon={LinkSquare02Icon} size={11} stroke={1.9} />
          </IconButton>
        ) : null}
      </span>
      {branches ? (
        <>
          {dot}
          <span className="truncate">{branches}</span>
        </>
      ) : null}
      {ended ? (
        <>
          {dot}
          <span className="shrink-0 font-sans">{ended}</span>
        </>
      ) : null}
    </div>
  );
}

function Section({ title, gap, children }: { title: string; gap?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="m-0 pb-3 font-semibold text-11 text-faint">{title}</h2>
      <div className={cn("flex flex-col", gap && "gap-3")}>{children}</div>
    </section>
  );
}

function CheckGlyph({ state }: { state: CheckRun["state"] }) {
  const box = "grid size-[13px] shrink-0 place-items-center";
  switch (state) {
    case "passing":
      return <Icon icon={Tick02Icon} size={13} stroke={2.4} className="text-pr-open" />;
    case "failing":
      return <Icon icon={Cancel01Icon} size={13} stroke={2.4} className="text-pr-failing" />;
    case "running":
      return (
        <span className={box}>
          <span className="breathe size-1.5 rounded-pill bg-pr-running" />
        </span>
      );
    case "queued":
      return (
        <span className={box}>
          <span className="size-1.5 rounded-pill shadow-[inset_0_0_0_1.5px_var(--c-faint)]" />
        </span>
      );
    case "skipped":
      return <Icon icon={MinusSignIcon} size={13} stroke={2} className="text-faint" />;
  }
}

const CHECK_WORD: Record<CheckRun["state"], string> = {
  passing: "Passed",
  failing: "Failed",
  running: "Running",
  queued: "Queued",
  skipped: "Skipped",
};

/** A check: how it stands, its name, and how long it took or what it says. Opens on GitHub. */
function CheckRow({ check, onOpenLink }: { check: CheckRun; onOpenLink: (url: string) => void }) {
  const took =
    check.startedAt && check.completedAt
      ? duration(Date.parse(check.completedAt) - Date.parse(check.startedAt))
      : null;
  const meta = took ?? check.description ?? CHECK_WORD[check.state];
  const content = (
    <>
      <span className="sr-only">{CHECK_WORD[check.state]}: </span>
      <CheckGlyph state={check.state} />
      <span className="min-w-0 truncate">{check.name}</span>
      <span className="ml-auto shrink-0 font-mono text-11 text-faint">{meta}</span>
    </>
  );
  const row = "flex h-7 items-center gap-2 text-13";
  if (!check.url) return <div className={row}>{content}</div>;
  const url = check.url;
  return (
    <button
      type="button"
      onClick={() => onOpenLink(url)}
      className={cn(
        row,
        "-mx-2 cursor-default rounded-7 px-2 text-left outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover active:bg-press",
      )}
    >
      {content}
    </button>
  );
}

/** Someone on GitHub as the tab names them: "You", "Claude", or their name. */
function authorName(author: GithubAuthor, viewerLogin: string): string {
  if (author.agent) return "Claude";
  if (author.login === viewerLogin) return "You";
  return author.name?.trim().split(/\s+/)[0] || author.login;
}

function AuthorAvatar({ author }: { author: GithubAuthor }) {
  if (author.agent) {
    return (
      <span className="grid size-5 shrink-0 place-items-center rounded-pill bg-chip">
        <AgentMark client="claude" size={11} />
      </span>
    );
  }
  return (
    <Avatar
      person={{
        id: author.login,
        name: author.name ?? author.login,
        login: author.login,
        avatarUrl: author.avatarUrl,
      }}
      size={20}
    />
  );
}

function Comment({
  comment,
  viewerLogin,
  onOpenLink,
}: {
  comment: PrComment;
  viewerLogin: string;
  onOpenLink: (url: string) => void;
}) {
  const now = useNow();
  const where = comment.path
    ? `${comment.path.split("/").pop()}${comment.line ? `:${comment.line}` : ""}`
    : null;
  return (
    <article className="flex gap-[9px]">
      <AuthorAvatar author={comment.author} />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="text-12">
          <b className="font-semibold">{authorName(comment.author, viewerLogin)}</b>
          <span className="text-faint">
            {where ? ` · ${where}` : ""} · {ago(comment.at, now, "compact")}
          </span>
        </span>
        <Prose text={comment.body} onOpenLink={onOpenLink} className="text-13 leading-[1.5]" />
      </div>
    </article>
  );
}

function ReviewRow({ review, viewerLogin }: { review: PrReview; viewerLogin: string }) {
  const now = useNow();
  return (
    <div className="flex h-7 items-center gap-2 text-13">
      <AuthorAvatar author={review.author} />
      <span className="min-w-0 truncate">
        {authorName(review.author, viewerLogin)}{" "}
        {review.state === "approved" ? "approved" : "requested changes"}
      </span>
      <span className="ml-auto shrink-0 font-mono text-11 text-faint">
        {ago(review.at, now, "compact")}
      </span>
    </div>
  );
}

function DetailsSkeleton({ rows }: { rows: number }) {
  return (
    <div role="status" aria-label="Loading the pull request" className="flex flex-col gap-2">
      <Skeleton className="mb-2 h-2.5 w-12 rounded-3" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have nothing else to tell them apart
          key={i}
          className="h-5 rounded-4"
          style={{ width: `${88 - (i % 3) * 16}%`, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}
