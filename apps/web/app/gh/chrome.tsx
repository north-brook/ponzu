import type { ReactNode } from "react";
import { GitHub, Slice } from "@/components/icons";
import { CopyField } from "./copy";
import type { CommitInfo, ListedDesign, RepoInfo, ViewerErrorKind } from "./github";
import { type Repo, viewerPath } from "./target";

/*
 * The viewer's surfaces, one component each, with only the fields they show
 * passed in. Deliberately plain for now: their design is still being settled
 * in a Ponzu file, and they'll be restyled from it.
 */

export const SITE = "https://ponzu.design";
const BADGE = `${SITE}/badge.svg`;

/** The README badge's markdown, linking to `path` in the viewer. */
export function badgeMarkdown(repo: Repo, path = ""): string {
  return `[![Open in Ponzu](${BADGE})](${SITE}${viewerPath(repo, path)})`;
}

/** Shell commands that open a design from the repo in Ponzu locally. */
export function localCommands(repo: RepoInfo, ref: string | null, path: string): string {
  const lines = [`git clone ${repo.url}.git`, `cd ${repo.repo}`];
  if (ref) lines.push(`git checkout ${ref}`);
  lines.push(`bunx ponzu serve ${/[\s'"$`\\]/.test(path) ? `'${path}'` : path}`);
  return lines.join(" && ");
}

/** The thin bar over the canvas: where this design comes from, and what to do with it. */
export function ViewerBar({
  repo,
  gitRef,
  refInUrl,
  commit,
  path,
  name,
  githubUrl,
}: {
  repo: RepoInfo;
  /** The branch, tag or commit shown. (`ref` is React's own prop.) */
  gitRef: string;
  refInUrl: boolean;
  commit: CommitInfo;
  path: string;
  name: string;
  githubUrl: string;
}) {
  const link: Repo = { owner: repo.owner, repo: repo.repo, ref: refInUrl ? gitRef : undefined };
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-rule bg-ground px-3 text-sm">
      <a href="/" className="flex items-center" aria-label="Ponzu">
        <Slice size={22} />
      </a>
      <nav className="flex min-w-0 items-center gap-1.5 text-muted" aria-label="Design">
        <a className="truncate hover:text-ink" href={viewerPath(link)}>
          {repo.fullName}
        </a>
        <span aria-hidden="true">›</span>
        <span className="truncate font-medium text-ink" title={path}>
          {name}
        </span>
        <a
          className="shrink-0 font-mono text-xs text-faint hover:text-muted"
          href={commit.url}
          title={`${commit.title} (${commit.author})`}
        >
          {refInUrl ? `${gitRef} · ` : ""}
          {commit.shortSha}
        </a>
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Popover id="badge" label="Add to README">
          <BadgePanel markdown={badgeMarkdown(link, path)} />
        </Popover>
        <a
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-muted hover:text-ink"
          href={githubUrl}
        >
          <GitHub />
          View on GitHub
        </a>
        <Popover id="open" label="Open in Ponzu" primary>
          <OpenPanel commands={localCommands(repo, refInUrl ? gitRef : null, path)} />
        </Popover>
      </div>
    </header>
  );
}

/** A button and its panel, on the browser's own popover: light dismiss, Esc and focus for free. */
function Popover({
  id,
  label,
  primary,
  children,
}: {
  id: string;
  label: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        popoverTarget={`pz-${id}`}
        className={
          primary
            ? "rounded-full bg-cta px-3.5 py-1.5 font-semibold text-cta-ink"
            : "rounded-full px-3 py-1.5 text-muted hover:text-ink"
        }
      >
        {label}
      </button>
      <div
        id={`pz-${id}`}
        popover="auto"
        className="fixed top-14 right-3 left-auto m-0 w-[min(400px,calc(100vw-24px))] rounded-xl border border-rule bg-ground p-4 text-sm text-text shadow-[0_12px_40px_var(--shot-shadow)]"
      >
        {children}
      </div>
    </>
  );
}

/** How to take this design home: the Mac app, or the commands that serve it. */
export function OpenPanel({ commands }: { commands: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-muted">
        Ponzu runs on your machine. Open this design there to comment on it and have your agent
        change it.
      </p>
      <CopyField label="From a terminal" value={commands} />
      <a className="font-medium text-ink underline underline-offset-4" href="/download">
        Or download Ponzu for Mac
      </a>
    </div>
  );
}

/** The badge, and its markdown to paste into a README. */
export function BadgePanel({ markdown }: { markdown: string }) {
  return (
    <div className="flex flex-col gap-3">
      {/* biome-ignore lint/performance/noImgElement: a static SVG, shown at its own size. */}
      <img src="/badge.svg" alt="Open in Ponzu" width={112} height={20} />
      <p className="m-0 text-muted">Link your README here, so anyone can open it on the canvas.</p>
      <CopyField label="Markdown" value={markdown} />
    </div>
  );
}

/** A repo's (or folder's) designs, each a link to the canvas. */
export function DesignList({
  repo,
  gitRef,
  refInUrl,
  commit,
  prefix,
  designs,
  truncated,
}: {
  repo: RepoInfo;
  gitRef: string;
  refInUrl: boolean;
  commit: CommitInfo;
  prefix: string;
  designs: ListedDesign[];
  truncated: boolean;
}) {
  const link: Repo = { owner: repo.owner, repo: repo.repo, ref: refInUrl ? gitRef : undefined };
  return (
    <main className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-2">
        <a href="/" className="w-fit" aria-label="Ponzu">
          <Slice size={28} />
        </a>
        <h1 className="m-0 font-display text-3xl font-semibold tracking-[-0.02em] text-ink">
          {repo.fullName}
          {prefix ? <span className="text-faint">/{prefix}</span> : null}
        </h1>
        <p className="m-0 text-muted">
          {designs.length === 1 ? "1 design" : `${designs.length} designs`} at{" "}
          <a className="font-mono text-sm" href={commit.url}>
            {refInUrl ? `${gitRef} · ` : ""}
            {commit.shortSha}
          </a>{" "}
          · <a href={repo.url}>GitHub</a>
        </p>
      </header>
      {designs.length === 0 ? (
        <p className="m-0 text-muted">
          No .design folders here. A design is a folder ending in .design, with a design.json and
          its pages.
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
          {designs.map((d) => (
            <li key={d.path}>
              <a
                className="flex flex-col gap-1 rounded-2xl bg-tile p-5 hover:bg-chip"
                href={viewerPath(link, d.path)}
              >
                <span className="font-semibold text-ink">{d.name}</span>
                <span className="font-mono text-xs text-faint">{d.path}</span>
                <span className="text-sm text-muted">
                  {plural(d.pages, "page")} · {plural(d.artboards, "artboard")}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {truncated ? (
        <p className="m-0 text-sm text-faint">
          This repo is too big for GitHub to list in full, so some designs may be missing. Link to
          one by its path to open it.
        </p>
      ) : null}
      {designs.length > 0 ? <BadgePanel markdown={badgeMarkdown(link, prefix)} /> : null}
    </main>
  );
}

const MESSAGES: Record<ViewerErrorKind | "url", { title: string; body: string }> = {
  url: {
    title: "That isn't a GitHub path",
    body: "Viewer links look like ponzu.design/gh/owner/repo/path/to/name.design.",
  },
  repo: {
    title: "Repo not found",
    body: "Either it doesn't exist or it's private. Ponzu can only show designs in public repos.",
  },
  ref: {
    title: "No such branch, tag or commit",
    body: "GitHub doesn't know that ref in this repo.",
  },
  design: {
    title: "No design here",
    body: "There's no .design folder at this path. Check the spelling, or see every design in the repo.",
  },
  empty: {
    title: "This design is empty",
    body: "The folder has no design.json or pages yet.",
  },
  "too-big": {
    title: "Too big to show here",
    body: "This design has more files than the web viewer reads. Clone the repo and open it in Ponzu.",
  },
  "rate-limited": {
    title: "GitHub needs a minute",
    body: "We've hit GitHub's rate limit. Try again in a few minutes.",
  },
  unavailable: {
    title: "Couldn't reach GitHub",
    body: "GitHub didn't answer, or we've hit its rate limit. Try again in a few minutes.",
  },
};

/** Why a design couldn't be shown, and where to go instead. */
export function ViewerErrorPage({
  kind,
  repo,
  repoUrl,
  retry,
}: {
  kind: ViewerErrorKind | "url";
  /** The repo's viewer listing, for errors about a path in it. */
  repo?: string;
  /** The repo on GitHub. */
  repoUrl?: string;
  retry?: () => void;
}) {
  const { title, body } = MESSAGES[kind];
  return (
    <main className="mx-auto flex min-h-dvh max-w-[520px] flex-col items-center justify-center gap-4 px-6 text-center">
      <Slice size={48} />
      <h1 className="m-0 font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      <p className="m-0 text-muted">{body}</p>
      <div className="flex flex-wrap justify-center gap-4 text-sm">
        {retry ? (
          <button type="button" className="font-medium text-ink underline" onClick={retry}>
            Try again
          </button>
        ) : null}
        {repo ? (
          <a className="text-ink underline" href={repo}>
            Designs in this repo
          </a>
        ) : null}
        {repoUrl ? (
          <a className="text-ink underline" href={repoUrl}>
            Open on GitHub
          </a>
        ) : null}
        <a className="text-ink underline" href="/">
          Ponzu home
        </a>
      </div>
    </main>
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
