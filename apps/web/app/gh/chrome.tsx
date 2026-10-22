import type { ReactNode, SVGProps } from "react";
import { GitHub, Slice } from "@/components/icons";
import { CopyBlock, CopyButton, CopyText } from "./copy";
import type { ListedDesign, RepoInfo, ViewerErrorKind } from "./github";
import { type Repo, viewerPath } from "./target";

/*
 * The viewer's surfaces, as designed in .context/github-viewer.design: one quiet bar that only
 * says where you are, one primary action, and an icon on every button.
 */

export const SITE = "https://ponzu.design";
const BADGE = `${SITE}/badge.svg`;

/**
 * The README badge's markdown, linking to `path` in the viewer. A design's badge carries its
 * name (`Kettle | Ponzu`); a repo's or folder's reads `open in | Ponzu`.
 */
export function badgeMarkdown(repo: Repo, path = "", name?: string): string {
  const src = name ? `${BADGE}?label=${encodeURIComponent(name)}` : BADGE;
  return `[![${name ?? "open in"} | Ponzu](${src})](${SITE}${viewerPath(repo, path)})`;
}

/** Shell commands that open a design from the repo in Ponzu locally, one per line. */
export function localCommands(repo: RepoInfo, ref: string | null, path: string): string {
  const lines = [`git clone ${repo.url}`, `cd ${repo.repo}`];
  if (ref) lines.push(`git checkout ${ref}`);
  lines.push(`bunx ponzu serve ${/[\s'"$`\\]/.test(path) ? `'${path}'` : path}`);
  return lines.join("\n");
}

const pill =
  "inline-flex h-[34px] shrink-0 items-center gap-2 rounded-full font-semibold whitespace-nowrap";

interface Crumb {
  label: string;
  href?: string;
  title?: string;
}

/**
 * The bar over every viewer page: the slice home, `owner / repo / Design`, then GitHub as an icon
 * and the one primary action. A ref named in the URL rides on the repo, as `repo@ref`.
 */
export function TopBar({
  crumbs,
  githubUrl,
  children,
}: {
  /** From the owner down; the last is where you are. */
  crumbs: Crumb[];
  githubUrl?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-rule bg-ground pr-3 pl-[18px] text-sm">
      <a href="/" className="mr-3 flex shrink-0 items-center" aria-label="Ponzu">
        <Slice size={22} />
      </a>
      <nav className="flex min-w-0 items-center gap-2 whitespace-nowrap" aria-label="Breadcrumb">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const cls = last ? "truncate font-semibold text-ink" : "shrink-0 text-muted";
          return (
            // On a phone only the last crumb shows; the rest are a tap away on GitHub.
            <span key={c.label} className={last ? "contents" : "contents max-sm:hidden"}>
              {i > 0 ? (
                <span aria-hidden="true" className="text-outline max-sm:hidden">
                  /
                </span>
              ) : null}
              {c.href && !last ? (
                <a className={`${cls} hover:text-ink`} href={c.href} title={c.title}>
                  {c.label}
                </a>
              ) : (
                <span className={cls} title={c.title} aria-current={last ? "page" : undefined}>
                  {c.label}
                </span>
              )}
            </span>
          );
        })}
      </nav>
      <span className="flex-1" />
      {githubUrl ? (
        <a
          className="grid size-[34px] shrink-0 place-items-center rounded-full text-[17px] text-muted transition-colors hover:bg-chip hover:text-ink"
          href={githubUrl}
          aria-label="View on GitHub"
          title="View on GitHub"
        >
          <GitHub />
        </a>
      ) : null}
      {children}
    </header>
  );
}

/** The repo's crumbs: owner, then `repo` or `repo@ref`, linking to its designs. */
export function repoCrumbs(repo: RepoInfo, link: Repo): Crumb[] {
  return [
    { label: repo.owner, href: `https://github.com/${repo.owner}` },
    {
      label: link.ref ? `${repo.repo}@${link.ref}` : repo.repo,
      href: viewerPath(link),
      title: `Every design in ${repo.fullName}`,
    },
  ];
}

/** "Open in Ponzu", and the panel that says how. */
export function OpenInPonzu({
  name,
  commands,
  badge,
}: {
  name: string;
  commands: string;
  /** This design's README badge, as markdown. */
  badge: string;
}) {
  return (
    <>
      <button
        type="button"
        popoverTarget="pz-open"
        className={`${pill} bg-cta pr-[15px] pl-3 text-[13.5px] text-cta-ink transition-[translate] duration-150 ease-out hover:-translate-y-px`}
      >
        <Slice size={15} className="[--slice:var(--yuzu)] dark:[--slice:var(--cta-ink)]" />
        <span>
          Open<span className="max-sm:hidden"> in Ponzu</span>
        </span>
      </button>
      <div
        id="pz-open"
        popover="auto"
        className="fixed top-[62px] right-3 left-auto m-0 w-[min(484px,calc(100vw-24px))] rounded-2xl bg-ground p-1.5 text-[13.5px]/[1.45] text-text shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_2px_4px_rgba(0,0,0,0.04),0_16px_48px_rgba(0,0,0,0.14)] dark:shadow-[0_0_0_1px_var(--rule),0_16px_48px_rgba(0,0,0,0.6)]"
      >
        <div className="px-3.5 pt-3.5 pb-2.5">
          <div className="text-[15px] font-semibold tracking-[-0.01em]">Make it yours</div>
          <p className="m-0 mt-0.5 text-muted">
            Open {name} on your Mac, then ask your agent for changes and leave comments right on the
            canvas.
          </p>
        </div>
        <a className="flex gap-3 rounded-[11px] bg-chip px-3.5 py-3" href="/download">
          <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-ground shadow-[0_0_0_1px_var(--rule)]">
            <Slice size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between font-semibold">
              Get the Mac app
              <Icon d="M7 17 17 7M9 7h8v8" className="text-faint" />
            </span>
            <span className="block text-[13px] text-muted">
              Opens .design folders like documents and sets up Claude Code, Codex and Cursor for
              you.
            </span>
          </span>
        </a>
        <div className="flex gap-3 px-3.5 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-chip text-[18px] text-text">
            <Icon d="m5 8 4 4-4 4M12 16h7" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">Run it from the terminal</span>
            <span className="block text-[13px] text-muted">
              Any OS, nothing to install beyond Bun. Your agent connects over MCP.
            </span>
            <span className="mt-2.5 block">
              <CopyBlock value={commands} />
            </span>
          </span>
        </div>
        <div className="mx-2 mt-0.5 mb-1.5 flex items-center gap-1.5 border-t border-rule px-1.5 pt-2.5 text-[12.5px] whitespace-nowrap text-faint">
          Free and open source · MIT
          <span className="flex-1" />
          <CopyText value={badge}>Copy README badge</CopyText>
        </div>
      </div>
    </>
  );
}

/** A repo's (or folder's) designs, each a link to the canvas. */
export function DesignList({
  repo,
  link,
  prefix,
  designs,
  truncated,
  commitLabel,
}: {
  repo: RepoInfo;
  link: Repo;
  prefix: string;
  designs: ListedDesign[];
  truncated: boolean;
  /** `main · 3f2a91c`. */
  commitLabel: string;
}) {
  const crumbs = repoCrumbs(repo, link);
  if (prefix) crumbs.push({ label: prefix });
  const count = designs.length === 1 ? "1 design" : `${designs.length} designs`;
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar crumbs={crumbs} githubUrl={repo.url} />
      <main className="mx-auto flex w-full max-w-[1088px] flex-col gap-8 px-6 pt-14 pb-24">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="m-0 font-display text-[34px]/[1.1] font-semibold tracking-[-0.03em] text-ink">
              {count} in {prefix || repo.repo}
            </h1>
            <p className="m-0 mt-2 text-[15px] text-muted">
              Every <code className="font-mono text-[13.5px] text-text">.design</code> folder,
              rendered live from the repo.
            </p>
          </div>
          <span className="rounded-lg bg-chip px-2.5 py-1.5 font-mono text-xs font-medium text-muted">
            {commitLabel}
          </span>
        </header>
        {designs.length === 0 ? (
          <p className="m-0 text-muted">
            No .design folders here. A design is a folder ending in .design, with a design.json and
            its pages.
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-7 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {designs.map((d) => (
              <li key={d.path}>
                <a className="group flex flex-col gap-3" href={viewerPath(link, d.path)}>
                  <span className="grid aspect-[16/11] place-items-center rounded-xl bg-tile shadow-[inset_0_0_0_1px_var(--rule)] transition-colors group-hover:bg-chip">
                    <Slice
                      size={40}
                      className="opacity-15 transition-opacity group-hover:opacity-30"
                    />
                  </span>
                  <span className="flex flex-col gap-0.5 px-0.5">
                    <span className="flex items-baseline justify-between gap-3 text-[15px] font-semibold text-ink">
                      {d.name}
                      <span className="shrink-0 text-[13px] font-normal text-faint">
                        {plural(d.pages, "page")} · {plural(d.artboards, "artboard")}
                      </span>
                    </span>
                    <span className="truncate font-mono text-[12.5px] text-muted">{d.path}</span>
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
        {designs.length > 0 ? (
          <div className="mt-5 flex flex-wrap items-center gap-4 rounded-[14px] bg-tile px-5 py-[18px]">
            <span className="min-w-[240px] flex-1 text-sm text-muted">
              <span className="font-semibold text-text">Maintain this repo?</span> Link your designs
              from the README so visitors can open them.
            </span>
            {/* biome-ignore lint/performance/noImgElement: an SVG badge, shown at its own size. */}
            <img src="/badge.svg" alt="open in | Ponzu" height={20} />
            <CopyButton value={designs.map((d) => badgeMarkdown(link, d.path, d.name)).join(" ")}>
              Copy markdown
            </CopyButton>
          </div>
        ) : null}
      </main>
    </div>
  );
}

/* Each failure, with a glyph, a plain title and body, and what to do next. */
const MESSAGES: Record<ViewerErrorKind | "url", { title: string; body: string; glyph: string }> = {
  url: {
    title: "That isn't a GitHub path",
    body: "Viewer links look like ponzu.design/gh/owner/repo/path/to/name.design.",
    glyph: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 8v4.5M12 16h.01",
  },
  repo: {
    title: "We can't see this repo",
    body: "It's private, renamed, or doesn't exist. The viewer only reads public repos, so private designs stay private.",
    glyph: "M10.5 3.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM15.5 15.5 21 21M8.5 8.5l4 4M12.5 8.5l-4 4",
  },
  ref: {
    title: "No such branch, tag or commit",
    body: "GitHub doesn't know that ref in this repo. It may have been renamed or deleted.",
    glyph:
      "M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM6 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM18 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM6 8.5v7M18 10.5c0 4-6 3-11 5.5",
  },
  design: {
    title: "No .design at this path",
    body: "It may have moved, or it lives on another branch.",
    glyph:
      "M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z",
  },
  empty: {
    title: "This design is empty",
    body: "The folder has no design.json or pages yet.",
    glyph: "M6 3h8l4 4v14H6ZM14 3v4h4",
  },
  "too-big": {
    title: "This one's too big for the browser",
    body: "It has more files than the web viewer reads. It opens fine in Ponzu on your Mac.",
    glyph:
      "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM14 3v4M3 10h4M21 14h-4M10 21v-4",
  },
  "rate-limited": {
    title: "GitHub asked us to slow down",
    body: "Lots of people are looking at designs right now, and GitHub caps how often we can read them. Try again in a minute.",
    glyph: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7.5V12l3 2",
  },
  unavailable: {
    title: "GitHub needs a minute",
    body: "GitHub is busy or didn't answer, and it caps how often we can read designs. Try again in a minute.",
    glyph: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7.5V12l3 2",
  },
};

/** Why a design couldn't be shown, and where to go instead. */
export function ViewerErrorPage({
  kind,
  owner,
  repo,
  path,
  retry,
}: {
  kind: ViewerErrorKind | "url";
  owner?: string;
  repo?: string;
  /** The design or folder asked for, as the last crumb. */
  path?: string;
  /** Errors GitHub may get over can be retried in place. */
  retry?: () => void;
}) {
  const { title, body, glyph } = MESSAGES[kind];
  const github = owner && repo ? `https://github.com/${owner}/${repo}` : undefined;
  const crumbs =
    owner && repo
      ? [
          { label: owner },
          { label: repo, href: kind === "repo" ? undefined : viewerPath({ owner, repo }) },
          ...(path
            ? [
                {
                  label:
                    path
                      .replace(/\.design$/, "")
                      .split("/")
                      .pop() ?? path,
                  title: path,
                },
              ]
            : []),
        ]
      : [];
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar crumbs={crumbs} githubUrl={github} />
      <main className="flex flex-1 flex-col items-center justify-center gap-[22px] px-6 pb-10 text-center">
        <span className="grid size-[88px] place-items-center rounded-3xl bg-tile text-[40px] text-muted shadow-[inset_0_0_0_1px_var(--rule)]">
          <Icon d={glyph} width={1.4} />
        </span>
        <div className="flex flex-col items-center gap-2">
          <h1 className="m-0 font-display text-[26px]/[1.15] font-semibold tracking-[-0.025em] text-balance text-ink">
            {title}
          </h1>
          <p className="m-0 max-w-[460px] text-[15px]/[1.55] text-pretty text-muted">{body}</p>
        </div>
        <div className="mt-1 flex flex-wrap justify-center gap-2.5">
          {retry ? (
            <button
              type="button"
              className={`${pill} bg-cta pr-[18px] pl-[15px] text-sm text-cta-ink`}
              onClick={retry}
            >
              <Icon d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
              Try again
            </button>
          ) : null}
          {kind === "design" && owner && repo ? (
            <a
              className={`${pill} bg-cta pr-[18px] pl-[15px] text-sm text-cta-ink`}
              href={viewerPath({ owner, repo })}
            >
              <Icon d="M4 4h7v7H4ZM13 4h7v7h-7ZM4 13h7v7H4ZM13 13h7v7h-7Z" />
              Every design in {repo}
            </a>
          ) : null}
          {github ? (
            <a
              className={`${pill} pr-[18px] pl-[15px] text-sm ${retry || kind === "design" ? "bg-chip font-medium text-text" : "bg-cta text-cta-ink"}`}
              href={github}
            >
              <GitHub />
              Open on GitHub
            </a>
          ) : (
            <a className={`${pill} bg-cta pr-[18px] pl-[15px] text-sm text-cta-ink`} href="/">
              <Slice size={15} className="[--slice:var(--yuzu)] dark:[--slice:var(--cta-ink)]" />
              Ponzu home
            </a>
          )}
        </div>
      </main>
    </div>
  );
}

/** A 24-unit line icon, sized by the font and drawn in the text color. */
export function Icon({
  d,
  width = 1.8,
  ...props
}: { d: string; width?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-[1em] shrink-0 ${props.className ?? ""}`}
    >
      <path d={d} />
    </svg>
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
