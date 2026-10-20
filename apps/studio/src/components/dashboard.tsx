import type { Catalog, CatalogArtboard, CatalogFile, CatalogMachine } from "@ponzu/core";
import { AgentMark, Icon, Tip, TipProvider, timeAgo } from "@ponzu/react";
import Fuse, { type FuseResultMatch } from "fuse.js";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** What opening a design needs: its key on its own Mac, and the server path in front of it. */
export interface OpenTarget {
  key: string;
  base: string;
}

const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

/**
 * The home screen. Until this Mac has a design of its own it walks through the
 * first steps; after that it's the catalog: every design on this Mac and the
 * person's other Macs, newest first, with search over files and their frames.
 */
export function Dashboard({
  catalog,
  onOpen,
  onOpenFolder,
  onNew,
}: {
  catalog: Catalog | null;
  onOpen: (target: OpenTarget) => void;
  onOpenFolder?: () => void;
  onNew?: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  // ⌘K, or typing anywhere on the home screen, goes to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const files = catalog?.files ?? [];
  const machines = useMemo(
    () => new Map((catalog?.machines ?? []).map((m) => [m.id, m])),
    [catalog?.machines],
  );
  // Setup shows until this Mac has a design, read yet or not.
  const setup = catalog !== null && !files.some((f) => f.machine === "local");
  const q = query.trim();

  return (
    <div className="h-full overflow-auto rounded-xl bg-home">
      <div className="mx-auto flex max-w-[1088px] flex-col gap-7 px-8 pt-12 pb-12">
        <TipProvider>
          <div className="flex items-center gap-1">
            <label className="search flex h-10 flex-1 items-center gap-2.5 rounded-[10px] bg-card px-3.5 text-[14px]">
              <Icon name="search" size={18} className="shrink-0 text-faint" />
              <input
                ref={search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder="Search designs"
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
              />
              {q ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="grid size-5 place-items-center rounded text-faint hover:text-foreground"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  <Icon name="close" size={14} strokeWidth={1.8} />
                </button>
              ) : (
                <span className="text-faint text-xs">{mod}K</span>
              )}
            </label>
            <span className="w-1.5" />
            {onOpenFolder && (
              <IconButton label="Open" keys={["⌘", "O"]} icon="folderOpen" onClick={onOpenFolder} />
            )}
            {onNew && <IconButton label="New" keys={["⌘", "N"]} icon="add" onClick={onNew} />}
          </div>
        </TipProvider>

        {q ? (
          <Results query={q} files={files} machines={machines} onOpen={onOpen} />
        ) : setup ? (
          <Setup catalog={catalog} files={files} machines={machines} onOpen={onOpen} />
        ) : (
          <>
            <Heading
              left="Recent"
              right={`${plural(files.length, "file")}${machines.size > 1 ? ` on ${machines.size} Macs` : ""}`}
            />
            <Grid>
              {files.map((f) => (
                <FileCard key={f.id} file={f} machine={machines.get(f.machine)} onOpen={onOpen} />
              ))}
            </Grid>
          </>
        )}
      </div>
    </div>
  );
}

function IconButton({
  label,
  keys,
  icon,
  onClick,
}: {
  label: string;
  keys: string[];
  icon: string;
  onClick: () => void;
}) {
  return (
    <Tip label={label} keys={keys}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="grid size-10 place-items-center rounded-[10px] text-foreground hover:bg-accent"
      >
        <Icon name={icon} size={20} strokeWidth={1.5} />
      </button>
    </Tip>
  );
}

/* ------------------------------------------------------------------ */
/* First steps                                                        */
/* ------------------------------------------------------------------ */

const PROMPT = "Design a landing page for my app in Ponzu.";

function Setup({
  catalog,
  files,
  machines,
  onOpen,
}: {
  catalog: Catalog | null;
  files: CatalogFile[];
  machines: Map<string, CatalogMachine>;
  onOpen: (target: OpenTarget) => void;
}) {
  const [copied, setCopied] = useState(false);
  const agents = catalog?.agents.filter((a) => a.found) ?? [];
  const connected = agents.some((a) => a.connected);
  // Step 2 is done once an agent is designing something here, not when one merely
  // connects: until then the prompt stays to copy.
  const working = files.find((f) => f.busy && f.machine === "local");
  const asked = Boolean(working);
  return (
    <>
      <div className="mt-3 flex max-w-[640px] flex-col gap-4">
        <h1 className="m-0 font-semibold text-[22px] leading-7 tracking-[-0.02em]">Get started</h1>
        <div className="flex flex-col rounded-[14px] bg-card shadow-[0_0_0_1px_var(--hairline),0_1px_2px_rgba(0,0,0,0.03)]">
          <Step
            n={1}
            done={connected}
            active={!connected}
            title={
              agents.length
                ? connected
                  ? "Your agents are connected"
                  : window.ponzuDesktop
                    ? "Connecting your agents…"
                    : "Connect your agents"
                : "Install a coding agent"
            }
          >
            {agents.length ? (
              <div className="flex flex-wrap items-center gap-2">
                {agents.map((a) => (
                  <span
                    key={a.id}
                    className="flex h-[30px] items-center gap-2 rounded-lg bg-secondary pr-2.5 pl-[9px] text-[12.5px]"
                  >
                    <AgentMark client={a.id === "codex" ? "openai" : a.id} size={14} />
                    {a.label}
                    {a.connected ? (
                      <Icon name="check" size={13} strokeWidth={2} className="text-online" />
                    ) : window.ponzuDesktop ? (
                      // The app registers agents as it starts.
                      <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent text-faint" />
                    ) : (
                      <span className="text-faint">not set up</span>
                    )}
                  </span>
                ))}
                {!connected && !window.ponzuDesktop && (
                  <span className="text-[12.5px] text-muted-foreground">
                    Run <code className="font-mono text-xs">ponzu install</code>
                  </span>
                )}
              </div>
            ) : (
              <p className="m-0 text-[12.5px] text-muted-foreground">
                Ponzu works with Claude Code, Codex and Cursor. Install one and it connects on its
                own.
              </p>
            )}
          </Step>
          <i className="mx-5 block h-px bg-hairline" />
          <Step n={2} done={asked} active={connected && !asked} title="Ask one for a design">
            {asked ? (
              <p className="m-0 text-[12.5px] text-muted-foreground">
                {agentName(working?.busy, catalog?.agent?.name)} is designing{" "}
                <b className="font-medium text-foreground">{working?.name}</b>.
              </p>
            ) : (
              <div className="flex h-11 items-center gap-3 rounded-[10px] bg-secondary pr-3 pl-3.5 shadow-[inset_0_0_0_1px_var(--hairline)]">
                <span className="flex-1 font-mono text-[12.5px]">{PROMPT}</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(PROMPT);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  }}
                  className={cn(
                    "flex items-center gap-1.5 text-[12.5px]",
                    copied ? "text-online" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon name={copied ? "check" : "copy"} size={15} />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}
          </Step>
        </div>
      </div>
      <Heading left="Recent" />
      {files.length ? (
        <Grid>
          {files.map((f) => (
            <FileCard key={f.id} file={f} machine={machines.get(f.machine)} onOpen={onOpen} />
          ))}
        </Grid>
      ) : (
        <Grid>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-2.5">
              <div className="ghost aspect-[16/11] rounded-xl" />
              <div className="flex flex-col gap-1.5 px-0.5">
                <i className="block h-[9px] w-[46%] rounded bg-secondary" />
                <i className="block h-2 w-[30%] rounded bg-secondary/70" />
              </div>
            </div>
          ))}
        </Grid>
      )}
    </>
  );
}

function Step({
  n,
  done,
  active,
  title,
  children,
}: {
  n: number;
  done: boolean;
  active: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3.5 px-5 py-[18px]">
      {done ? (
        <span className="grid size-[22px] shrink-0 place-items-center rounded-full bg-foreground text-background">
          <Icon name="check" size={13} strokeWidth={2.2} />
        </span>
      ) : (
        <span
          className={cn(
            "grid size-[22px] shrink-0 place-items-center rounded-full font-semibold text-xs",
            active
              ? "bg-flesh text-[#0e0e0e]"
              : "text-faint shadow-[inset_0_0_0_1.5px_var(--hairline-strong)]",
          )}
        >
          {n}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5">
        <span
          className={cn("font-medium text-[14px]", !done && !active && "text-muted-foreground")}
        >
          {title}
        </span>
        {children}
      </div>
    </div>
  );
}

function agentName(client?: string, fallback?: string): string {
  if (client === "claude") return "Claude";
  if (client === "openai") return "Codex";
  if (client === "cursor") return "Cursor";
  return fallback ?? "Your agent";
}

/* ------------------------------------------------------------------ */
/* Files                                                              */
/* ------------------------------------------------------------------ */

function Heading({ left, right }: { left: string; right?: string }) {
  return (
    <div className="-mb-3.5 flex items-baseline justify-between text-muted-foreground text-xs">
      <span>{left}</span>
      {right && <span>{right}</span>}
    </div>
  );
}

function Grid({ children, columns = 4 }: { children: ReactNode; columns?: 3 | 4 }) {
  return (
    <div
      className={cn(
        "grid gap-x-5 gap-y-7",
        columns === 4
          ? "grid-cols-4 max-[1100px]:grid-cols-3 max-[820px]:grid-cols-2"
          : "grid-cols-3 max-[820px]:grid-cols-2",
      )}
    >
      {children}
    </div>
  );
}

function FileCard({
  file,
  machine,
  onOpen,
  match,
  pathMatch,
}: {
  file: CatalogFile;
  machine?: CatalogMachine;
  onOpen: (target: OpenTarget) => void;
  match?: readonly [number, number][];
  /** Where a search matched the file's path, when it matched there and not in the name. */
  pathMatch?: readonly [number, number][];
}) {
  const fresh = file.created !== undefined && Date.now() - file.created < 5 * 60_000;
  return (
    <button
      type="button"
      className="group flex min-w-0 flex-col gap-2.5 text-left"
      onClick={() => onOpen({ key: file.key, base: file.base })}
      title={file.locked ? `${file.key}\nOpen it to let Ponzu read this folder.` : file.key}
    >
      <div
        className={cn(
          "relative aspect-[16/11] overflow-hidden rounded-xl bg-preview transition-shadow",
          file.busy || fresh
            ? "shadow-[0_0_0_1.5px_var(--rind),0_6px_20px_rgba(244,176,18,0.22)]"
            : "shadow-[0_0_0_1px_var(--hairline)] group-hover:shadow-[0_0_0_1px_var(--hairline-strong),0_4px_14px_rgba(0,0,0,0.06)]",
        )}
      >
        <Preview src={file.preview} />
        {file.busy && (
          <span className="absolute top-2.5 left-2.5 flex h-6 items-center gap-1.5 rounded-full bg-card/80 pr-2.5 pl-[7px] text-xs shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_2px_6px_rgba(0,0,0,0.06)] backdrop-blur-md">
            <AgentMark client={file.busy} size={13} />
            Designing…
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <span className="truncate font-medium text-[13.5px]">
          <Highlight text={file.name} ranges={match} />
        </span>
        {pathMatch && (
          <span className="truncate font-mono text-[11px] text-muted-foreground" dir="rtl">
            {/* Right to left, so a long path keeps its end; the marks stay on their letters. */}
            <bdi>
              <Highlight text={file.key} ranges={pathMatch} />
            </bdi>
          </span>
        )}
        <span className="flex items-center gap-[5px] text-muted-foreground text-xs">
          <Device machine={machine} />
          <span className="text-faint">·</span>
          <span>{ago(file.modified)}</span>
        </span>
      </div>
    </button>
  );
}

/**
 * The canvas preview, or an empty canvas while it's drawn (or when there's
 * none). Previews are drawn on the light canvas, so the tile behind them is
 * that color in either theme.
 */
function Preview({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed)
    return (
      <span className="absolute inset-0 grid place-items-center text-faint">
        <Icon name="blank" size={28} strokeWidth={1.3} />
      </span>
    );
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      className="absolute inset-0 size-full object-contain"
    />
  );
}

function Device({ machine }: { machine?: CatalogMachine }) {
  return (
    <span className="flex items-center gap-[5px]">
      <Icon
        name={machine?.kind === "laptop" ? "laptop" : "desktop"}
        size={13}
        strokeWidth={1.7}
        className="text-faint"
      />
      {machine?.name ?? "This Mac"}
    </span>
  );
}

function ago(ms: number): string {
  if (!ms) return "Edited a while ago";
  const t = timeAgo(ms);
  if (t === "now") return "Just now";
  const unit = t.slice(-1);
  const n = Number(t.slice(0, -1));
  if (unit === "m") return `${plural(n, "min")} ago`;
  if (unit === "h") return `${plural(n, "hour")} ago`;
  if (n === 1) return "Yesterday";
  if (n < 7) return `${n} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ */
/* Search                                                             */
/* ------------------------------------------------------------------ */

interface FrameHit {
  file: CatalogFile;
  artboard: CatalogArtboard;
  /** The name of the page it's on. */
  page?: string;
}

const FUSE = {
  includeMatches: true,
  ignoreLocation: true,
  threshold: 0.32,
  minMatchCharLength: 2,
} as const;

/**
 * Fuzzy search over everything the catalog knows: file names and paths,
 * then frames (artboards) by their name, their page's name and their file's.
 */
function Results({
  query,
  files,
  machines,
  onOpen,
}: {
  query: string;
  files: CatalogFile[];
  machines: Map<string, CatalogMachine>;
  onOpen: (target: OpenTarget) => void;
}) {
  const fileFuse = useMemo(
    () =>
      new Fuse(files, {
        ...FUSE,
        keys: [
          { name: "name", weight: 3 },
          { name: "key", weight: 0.5 },
        ],
      }),
    [files],
  );
  const frames = useMemo<FrameHit[]>(
    () =>
      files.flatMap((file) =>
        file.artboards.map((artboard) => ({
          file,
          artboard,
          page: file.pages.find((p) => p.id === artboard.page)?.name,
        })),
      ),
    [files],
  );
  const frameFuse = useMemo(
    () =>
      new Fuse(frames, {
        ...FUSE,
        keys: [
          { name: "artboard.name", weight: 3 },
          { name: "page", weight: 1 },
        ],
      }),
    [frames],
  );
  const fileHits = fileFuse.search(query, { limit: 24 });
  const frameHits = frameFuse.search(query, { limit: 30 });

  if (!fileHits.length && !frameHits.length)
    return <p className="mt-6 text-center text-muted-foreground">Nothing matches “{query}”.</p>;
  return (
    <>
      {fileHits.length > 0 && (
        <>
          <Heading left="Files" />
          <Grid>
            {fileHits.map(({ item, matches }) => (
              <FileCard
                key={item.id}
                file={item}
                machine={machines.get(item.machine)}
                onOpen={onOpen}
                match={ranges(matches, "name")}
                pathMatch={ranges(matches, "name") ? undefined : ranges(matches, "key")}
              />
            ))}
          </Grid>
        </>
      )}
      {frameHits.length > 0 && (
        <>
          <Heading left="Frames" />
          <Grid columns={3}>
            {frameHits.map(({ item, matches }) => (
              <FrameCard
                key={`${item.file.id}:${item.artboard.id}`}
                hit={item}
                machine={machines.get(item.file.machine)}
                match={ranges(matches, "artboard.name")}
                pageMatch={ranges(matches, "page")}
                onOpen={onOpen}
              />
            ))}
          </Grid>
        </>
      )}
    </>
  );
}

function FrameCard({
  hit,
  machine,
  match,
  pageMatch,
  onOpen,
}: {
  hit: FrameHit;
  machine?: CatalogMachine;
  match?: readonly [number, number][];
  pageMatch?: readonly [number, number][];
  onOpen: (target: OpenTarget) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="group flex min-w-0 flex-col gap-2.5 text-left"
      onClick={() => onOpen({ key: hit.file.key, base: hit.file.base })}
    >
      <div className="grid h-[200px] place-items-center overflow-hidden rounded-xl bg-preview p-5 shadow-[0_0_0_1px_var(--hairline)] transition-shadow group-hover:shadow-[0_0_0_1px_var(--hairline-strong),0_4px_14px_rgba(0,0,0,0.06)]">
        {failed ? (
          <Icon name="board" size={28} strokeWidth={1.3} className="text-faint" />
        ) : (
          <img
            src={hit.artboard.thumb}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setFailed(true)}
            className="block max-h-[160px] max-w-full object-contain shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_6px_rgba(0,0,0,0.06)]"
          />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <span className="truncate font-medium text-[13.5px]">
          <Highlight text={hit.artboard.name} ranges={match} />
        </span>
        <span className="flex min-w-0 items-center gap-[5px] text-muted-foreground text-xs">
          <span className="truncate">
            {hit.page ? <Highlight text={hit.page} ranges={pageMatch} /> : "Artboard"} in{" "}
            {hit.file.name}
          </span>
          <span className="text-faint">·</span>
          <Device machine={machine} />
        </span>
      </div>
    </button>
  );
}

function ranges(
  matches: readonly FuseResultMatch[] | undefined,
  key: string,
): readonly [number, number][] | undefined {
  return matches?.find((m) => m.key === key)?.indices as readonly [number, number][] | undefined;
}

/** The text with fuse's matched ranges marked. Single stray letters aren't. */
function Highlight({ text, ranges }: { text: string; ranges?: readonly [number, number][] }) {
  const spans = (ranges ?? []).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  if (!spans.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of spans) {
    if (a < at) continue;
    out.push(text.slice(at, a));
    out.push(
      <mark key={a} className="rounded-[2px] bg-highlight text-inherit">
        {text.slice(a, b + 1)}
      </mark>,
    );
    at = b + 1;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}
