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
  LoadedDiff,
  PrComment,
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
import { TEXT } from "../ui/ladder.ts";
import { safeHref } from "../ui/markdown.ts";
import { AgentMark } from "../ui/marks.tsx";
import { Prose } from "../ui/prose.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { orderChecks } from "./diff.ts";
import { Files, MoreOnGithub } from "./files.tsx";

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
 * and what changed. Details, checks, comments and approvals, then the files and their diffs:
 * stacked in a narrow column, side by side in a wide one (`Columns`). Read-only: replying is
 * GitHub's, or the agent's when asked in the thread, which stays open beside it. Sections with
 * nothing in them are left out.
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
  onLoadDiff?: (path: string) => Promise<LoadedDiff>;
}) {
  // GitHub's addresses (a check's page, a link in a comment) leave the app only to the web.
  const onOpenLink = (url: string) => {
    const href = safeHref(url);
    if (href) open(href);
  };
  if (state.kind !== "ready") {
    return (
      <Columns>
        <div className={cn(COLUMN, "gap-[26px]")}>
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
        <div className={cn(COLUMN, "gap-2.5")} aria-hidden>
          <Skeleton className="h-3.5 w-12 rounded-3" />
          {[0, 1, 2].map((i) => (
            <Skeleton
              key={i}
              className="h-9 rounded-10 bg-surface shadow-file-card"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          ))}
        </div>
      </Columns>
    );
  }

  const { pr } = state;
  return (
    <Columns>
      <div className={cn(COLUMN, "gap-[26px]")}>
        <div className="flex flex-col gap-3.5">
          <h1 className="m-0 font-display font-semibold text-26 leading-[1.1] tracking-[-0.02em] [overflow-wrap:anywhere]">
            {pr.title}
          </h1>
          <Subtitle
            state={pr.state}
            number={pr.number}
            branches={{ head: pr.head, base: pr.base }}
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
        <Section title="Checks">
          {pr.checks.length ? (
            orderChecks(pr.checks).map((check) => (
              <CheckRow key={check.id} check={check} onOpenLink={onOpenLink} />
            ))
          ) : (
            // Before a merge, none yet may mean none are set up, or none have started: say only
            // what is so. GitHub's own are a moment behind a push.
            <p className="m-0 flex h-7 items-center gap-2 text-13 text-muted">
              <CheckGlyph state="queued" />
              {pr.state === "open" || pr.state === "draft"
                ? "No checks have reported"
                : "No checks ran"}
            </p>
          )}
          {pr.checksComplete ? null : (
            <MoreOnGithub onOpen={() => onOpenLink(`${pr.url}/checks`)}>
              More checks than shown here.
            </MoreOnGithub>
          )}
        </Section>
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
      <div className={COLUMN}>
        <Files
          files={pr.files}
          total={pr.filesTotal}
          headSha={pr.headSha}
          additions={pr.additions}
          deletions={pr.deletions}
          url={pr.url}
          onOpenLink={onOpenLink}
          onLoadDiff={onLoadDiff}
        />
      </div>
    </Columns>
  );
}

/**
 * The tab lives in the canvas's column, which runs from about 400 (the smallest window with both
 * panes open, or the panes dragged wide) to the whole window. Narrower than 1080, the details
 * stack above the files in one column at a reading measure (680 at most), centred, and the pane
 * scrolls them as one; 24 at the sides under 520, 40 above. From 1080, room for the board's two
 * columns with the files at least 550, the details take the board's 380 column and the files the
 * rest, each scrolling on its own, the pair no wider than 1480 so a diff on a wide screen still
 * reads as lines.
 */
const COLUMN =
  "flex min-w-0 flex-col @min-[1080px]:min-h-0 @min-[1080px]:overflow-y-auto @min-[1080px]:py-11 @min-[1080px]:[scrollbar-width:thin]";

function Columns({ children }: { children: ReactNode }) {
  return (
    <div className="@container absolute inset-0">
      <div className="h-full overflow-y-auto [scrollbar-width:thin] @min-[1080px]:overflow-visible">
        <div
          data-pr-columns
          className="mx-auto flex max-w-[760px] flex-col gap-9 px-6 pt-8 pb-11 @min-[520px]:px-10 @min-[520px]:pt-11 @min-[1080px]:grid @min-[1080px]:h-full @min-[1080px]:max-w-[1480px] @min-[1080px]:grid-cols-[380px_minmax(0,1fr)] @min-[1080px]:gap-12 @min-[1080px]:py-0 @min-[1080px]:pr-12 @min-[1080px]:pl-14"
        >
          {children}
        </div>
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
  branches?: { head: string; base: string };
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
  // One line while it fits. A long head branch gives way first (the base always reads whole),
  // and what became of the pull request goes under rather than squeezing them; its dot, which
  // hangs in the margin the row is shifted into, is clipped when it starts a line.
  return (
    <div className="-my-1 min-w-0 overflow-hidden py-1">
      <div className="-ml-[23px] flex flex-wrap items-center gap-y-1 font-mono text-12 text-muted">
        <span className="flex min-w-0 max-w-full items-center gap-2 pl-[23px]">
          <span className="flex shrink-0 items-center gap-1">
            <Icon icon={icon} step="small" className={color} />#{number}
            {onOpen ? (
              <IconButton
                label="Open on GitHub"
                onClick={onOpen}
                className="-m-1 size-[19px] rounded-5 text-icon-soft"
              >
                <Icon icon={LinkSquare02Icon} step="meta" />
              </IconButton>
            ) : null}
          </span>
          {branches ? (
            <>
              {dot}
              <span className="min-w-0 truncate" title={branches.head}>
                {branches.head}
              </span>
              <span className="shrink-0">→ {branches.base}</span>
            </>
          ) : null}
        </span>
        {ended ? (
          <span className="flex shrink-0 items-center">
            <span aria-hidden className="w-[23px] shrink-0 text-center text-dry">
              ·
            </span>
            <span className="font-sans">{ended}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, gap, children }: { title: string; gap?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className={cn("m-0 pb-3", TEXT.label)}>{title}</h2>
      <div className={cn("flex flex-col", gap && "gap-3")}>{children}</div>
    </section>
  );
}

function CheckGlyph({ state }: { state: CheckRun["state"] }) {
  const box = "grid size-[13px] shrink-0 place-items-center";
  switch (state) {
    case "passing":
      return <Icon icon={Tick02Icon} step="small" className="text-pr-open" />;
    case "failing":
      return <Icon icon={Cancel01Icon} step="small" className="text-pr-failing" />;
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
      return <Icon icon={MinusSignIcon} step="small" className="text-faint" />;
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
      <span className={cn("ml-auto shrink-0", TEXT.meta)}>{meta}</span>
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
      <span className={cn("ml-auto shrink-0", TEXT.meta)}>{ago(review.at, now, "compact")}</span>
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
