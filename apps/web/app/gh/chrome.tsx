import { targetPath } from "@ponzu/core/github";
import { Icon as PageIcon } from "@ponzu/react/icons";
import type { ReactNode, SVGProps } from "react";
import { GitHub, Slice } from "@/components/icons";
import { CopyButton, CopyCommand } from "./copy";
import type { ListedDesign, RepoInfo, ViewerErrorKind } from "./github";
import { OpenAppButton } from "./open-app";
import { type Repo, viewerPath } from "./target";
import { DesignThumb } from "./thumb";

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

/**
 * The command that clones the repo and opens the design in Ponzu: `ponzu open` takes the viewer's
 * own path. Every segment is percent-encoded down to `[A-Za-z0-9_.~%-]`, so a ref or folder name
 * can't smuggle shell syntax into what people paste.
 */
export function openCommand(repo: Repo, path: string): string {
  return `bunx ponzu open ${targetPath(repo, path)}`;
}

/**
 * The link the Mac app opens a design from: `ponzu://open?repo=<owner>/<repo>&ref=<ref>&path=…`.
 * The app checks every part again before git sees it (@ponzu/server/clone).
 */
export function openLink(repo: Repo, path: string): string {
  const q = new URLSearchParams({ repo: `${repo.owner}/${repo.repo}` });
  if (repo.ref) q.set("ref", repo.ref);
  q.set("path", path);
  return `ponzu://open?${q}`;
}

export const pill =
  "inline-flex h-[34px] shrink-0 items-center gap-2 rounded-full font-semibold whitespace-nowrap";

interface Crumb {
  label: string;
  href?: string;
  title?: string;
  /** A design: a file icon before its name. */
  file?: boolean;
}

/**
 * The bar over every viewer page: the slice home, `owner / repo / Design`, then GitHub as an icon
 * and the one primary action. A ref named in the URL rides on the repo, as `repo@ref`. On a phone
 * it's the slice, the last crumb, `mobile` (a design's page picker) and GitHub, nothing else.
 */
export function TopBar({
  crumbs,
  githubUrl,
  mobile,
  children,
}: {
  /** From the owner down; the last is where you are. */
  crumbs: Crumb[];
  githubUrl?: string;
  /** Shown after the last crumb on a phone only. */
  mobile?: ReactNode;
  /** Shown from tablet width up. */
  children?: ReactNode;
}) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-rule bg-ground pr-3 pl-[18px] text-sm max-sm:gap-0 max-sm:pr-2.5">
      <a href="/" className="mr-3 flex shrink-0 items-center max-sm:mr-3.5" aria-label="Ponzu">
        <Slice size={22} />
      </a>
      <nav
        className="flex min-w-0 items-center gap-2 whitespace-nowrap max-sm:flex-1"
        aria-label="Breadcrumb"
      >
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const cls = last
            ? "flex min-w-0 items-center gap-[7px] font-semibold text-ink max-sm:text-[15px]"
            : "shrink-0 text-muted";
          const label = (
            <>
              {c.file ? (
                <PageIcon
                  name="blank"
                  size={15}
                  strokeWidth={1.5}
                  className="shrink-0 text-muted max-sm:hidden"
                />
              ) : null}
              <span className="truncate">{c.label}</span>
            </>
          );
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
                  {label}
                </a>
              ) : (
                <span className={cls} title={c.title} aria-current={last ? "page" : undefined}>
                  {label}
                </span>
              )}
            </span>
          );
        })}
        {mobile ? <span className="contents sm:hidden">{mobile}</span> : null}
      </nav>
      <span className="flex-1 max-sm:hidden" />
      {githubUrl ? (
        <a
          className="grid size-[34px] shrink-0 place-items-center rounded-full text-[17px] text-muted transition-colors hover:bg-chip hover:text-ink max-sm:text-[18px]"
          href={githubUrl}
          aria-label="View on GitHub"
          title="View on GitHub"
        >
          <GitHub />
        </a>
      ) : null}
      {children ? <span className="contents max-sm:hidden">{children}</span> : null}
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

/**
 * "Open in Ponzu", and the card that says why and how: change this design with your agent. The
 * Mac app is the way in, by a ponzu:// link; the terminal is the alternative, under a hairline.
 */
export function OpenInPonzu({
  name,
  link,
  command,
}: {
  name: string;
  /** The ponzu://open link the Mac app clones and opens (openLink). */
  link: string;
  /** The same, as a `bunx ponzu open` command (openCommand). */
  command: string;
}) {
  return (
    <>
      <button
        type="button"
        popoverTarget="pz-open"
        className={`${pill} bg-cta pr-[15px] pl-3 text-[13.5px] text-cta-ink transition-[translate,box-shadow] duration-150 ease-out hover:-translate-y-px [&:has(+:popover-open)]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--text)_14%,transparent)]`}
      >
        <Slice size={15} className="[--slice:var(--yuzu)] dark:[--slice:var(--cta-ink)]" />
        Open in Ponzu
      </button>
      <div
        id="pz-open"
        popover="auto"
        className="fixed top-[62px] right-3.5 left-auto m-0 flex w-[min(440px,calc(100vw-24px))] flex-col gap-4 rounded-2xl bg-well p-5 text-[13.5px]/[1.5] text-text shadow-[0_0_0_1px_rgba(0,0,0,0.05),0_2px_4px_rgba(0,0,0,0.04),0_16px_48px_rgba(0,0,0,0.14)] dark:shadow-[0_0_0_1px_var(--well-rule),0_16px_48px_rgba(0,0,0,0.6)]"
      >
        <div className="flex flex-col gap-1">
          <div className="font-display text-[17px]/[1.25] font-semibold tracking-[-0.015em] text-ink">
            Change {name} with your agent
          </div>
          <p className="m-0 text-muted">
            Ponzu clones the repo and opens {name} on your Mac. Leave comments on the canvas, your
            coding agent makes the changes, and you commit them like code.
          </p>
        </div>
        <OpenAppButton link={link} />
        <div className="flex flex-col gap-2 border-t border-rule pt-3.5 dark:border-well-rule">
          <div className="flex items-center justify-between gap-3 text-[12.5px] text-faint">
            <span>Not on a Mac, or prefer the terminal</span>
            <span className="shrink-0 text-muted">
              No app yet?{" "}
              <a className="font-medium text-text hover:text-ink" href="/download">
                Download
              </a>
            </span>
          </div>
          <CopyCommand value={command} />
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
                  <span className="relative grid aspect-[16/11] place-items-center overflow-hidden rounded-xl bg-tile transition-colors group-hover:bg-chip">
                    <Slice
                      size={40}
                      className="opacity-15 transition-opacity group-hover:opacity-30"
                    />
                    <DesignThumb thumb={d.thumb} />
                    <span className="pointer-events-none absolute inset-0 rounded-xl shadow-[inset_0_0_0_1px_var(--rule)]" />
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
