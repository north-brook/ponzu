import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LoadedDiff, PrDiff, PrFile } from "../model.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { TEXT } from "../ui/ladder.ts";
import { type DiffRow, isLarge, parsePatch, type Span } from "./diff.ts";

/** "+214 −38", in the pull request's colors. */
export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="ml-auto flex shrink-0 gap-1.5 font-mono font-normal text-12">
      <span className="text-pr-open">+{additions}</span>
      <span className="text-pr-failing">−{deletions}</span>
    </span>
  );
}

/** A quiet line under a list GitHub gave only the start of, with the way to the rest. */
export function MoreOnGithub({ children, onOpen }: { children: ReactNode; onOpen: () => void }) {
  return (
    <p className="m-0 flex items-center gap-2 py-1.5 text-12 text-muted">
      {children}
      <Button variant="quiet" onClick={onOpen} className="-my-1 px-2 text-ink">
        Open on GitHub
      </Button>
    </p>
  );
}

/**
 * The changed files, each a card that opens to its diff. An open card reads its diff again when
 * the head moves, so what the person reads is what a merge would ship.
 */
export function Files({
  files,
  total = files.length,
  headSha,
  additions,
  deletions,
  url,
  onOpenLink,
  onLoadDiff,
}: {
  /** The first of them, when GitHub lists fewer than `total`. */
  files: PrFile[];
  total?: number;
  /** The commit they are at. */
  headSha: string;
  additions: number;
  deletions: number;
  url: string;
  onOpenLink: (url: string) => void;
  /** Fetches a file's diff the tab wasn't sent. */
  onLoadDiff?: (path: string) => Promise<LoadedDiff>;
}) {
  // A pull request of one file starts with its diff open (board 3 draws one card open): there
  // is nothing else to choose between.
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(files.length === 1 && total === 1 ? [files[0]!.path] : []),
  );
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <section aria-label="Files changed" className="flex min-w-0 flex-col gap-2.5">
      <div className={cn("flex items-center", TEXT.label)}>
        {total > files.length ? `${files.length} of ${total.toLocaleString("en-US")}` : total}{" "}
        {total === 1 ? "file" : "files"}
        <Counts additions={additions} deletions={deletions} />
      </div>
      {files.map((file) => (
        <FileCard
          // A new head is a new diff: the card asks for it again.
          key={`${headSha}:${file.path}`}
          file={file}
          open={open.has(file.path)}
          onToggle={() => toggle(file.path)}
          onLoadDiff={onLoadDiff}
          onOpenOnGithub={() => onOpenLink(`${url}/files`)}
        />
      ))}
      {total > files.length ? (
        <MoreOnGithub onOpen={() => onOpenLink(`${url}/files`)}>
          The rest are on GitHub.
        </MoreOnGithub>
      ) : null}
    </section>
  );
}

function FileCard({
  file,
  open,
  onToggle,
  onLoadDiff,
  onOpenOnGithub,
}: {
  file: PrFile;
  open: boolean;
  onToggle: () => void;
  onLoadDiff: ((path: string) => Promise<LoadedDiff>) | undefined;
  onOpenOnGithub: () => void;
}) {
  const id = `file-${file.path}`;
  // Where a renamed file was comes with its diff.
  const [renamedFrom, setRenamedFrom] = useState<string | null>(null);
  const load = useMemo(
    () =>
      onLoadDiff &&
      (async (path: string) => {
        const loaded = await onLoadDiff(path);
        setRenamedFrom(loaded.previousPath);
        return loaded.diff;
      }),
    [onLoadDiff],
  );
  const previousPath = file.previousPath ?? renamedFrom;
  return (
    <div className="overflow-hidden rounded-10 bg-surface shadow-file-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="flex h-9 w-full cursor-default items-center gap-2 rounded-10 px-3 text-left font-mono text-13 outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover"
      >
        <Icon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          step="small"
          className="text-icon-soft"
        />
        {previousPath ? (
          <span className="min-w-0 truncate">
            <span className="text-faint">{previousPath} → </span>
            {file.path}
          </span>
        ) : (
          <FilePath path={file.path} />
        )}
        {file.status === "added" || file.status === "removed" ? (
          <span className="shrink-0 font-sans text-11 text-faint">
            {file.status === "added" ? "new" : "deleted"}
          </span>
        ) : null}
        <Counts additions={file.additions} deletions={file.deletions} />
      </button>
      {open ? (
        <div id={id} className="border-rule border-t">
          <FileBody file={file} onLoadDiff={load} onOpenOnGithub={onOpenOnGithub} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A file's path, which gives up its folders before its name when there's no room: the
 * folders end in an ellipsis, the name stays whole while it fits.
 */
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span className="flex min-w-0" title={path}>
      {/* Read as one: the two halves are blocks, which a name would put a space between. */}
      <span className="sr-only">{path}</span>
      {cut ? (
        <span aria-hidden className="min-w-0 truncate">
          {path.slice(0, cut)}
        </span>
      ) : null}
      <span aria-hidden className="max-w-full shrink-0 truncate">
        {path.slice(cut)}
      </span>
    </span>
  );
}

/**
 * A file's diff, or why it isn't shown: large enough to ask first, binary, or too large for
 * GitHub. A diff the tab wasn't sent is asked for here, the first time the card opens.
 */
function FileBody({
  file,
  onLoadDiff,
  onOpenOnGithub,
}: {
  file: PrFile;
  onLoadDiff?: (path: string) => Promise<PrDiff>;
  onOpenOnGithub: () => void;
}) {
  const [forced, setForced] = useState(false);
  const large = isLarge(file) && !forced;
  const diff = useDiff(file, large ? undefined : onLoadDiff);
  if (large) {
    return (
      <Quiet>
        {(file.additions + file.deletions).toLocaleString("en-US")} changed lines.
        <Button variant="quiet" onClick={() => setForced(true)} className="-my-1 px-2 text-ink">
          Show diff
        </Button>
      </Quiet>
    );
  }
  if (diff.status === "loading") return <DiffSkeleton />;
  if (diff.status === "failed") {
    return (
      <Quiet>
        <span role="alert">Couldn't load this diff.</span>
        <Button variant="quiet" onClick={diff.retry} className="-my-1 px-2 text-ink">
          Try again
        </Button>
      </Quiet>
    );
  }
  switch (diff.diff.kind) {
    case "binary":
      return <Quiet>Binary file, not shown.</Quiet>;
    case "too_large":
      return (
        <Quiet>
          GitHub doesn't show a diff this large.
          <Button variant="quiet" onClick={onOpenOnGithub} className="-my-1 px-2 text-ink">
            Open on GitHub
          </Button>
        </Quiet>
      );
    case "text":
      return <Diff patch={diff.diff.patch} />;
  }
}

type DiffState =
  | { status: "loading" }
  | { status: "failed"; retry: () => void }
  | { status: "ready"; diff: PrDiff };

/** The file's diff as it came, or as `load` brings it; asked for once each time it is retried. */
function useDiff(file: PrFile, load: ((path: string) => Promise<PrDiff>) | undefined): DiffState {
  const [fetched, setFetched] = useState<PrDiff | "failed" | null>(null);
  const { path, diff } = file;
  /** Only the latest ask's answer is taken. */
  const latest = useRef(0);
  const ask = useCallback(() => {
    if (!load) return;
    const mine = ++latest.current;
    setFetched(null);
    load(path).then(
      (answer) => latest.current === mine && setFetched(answer),
      () => latest.current === mine && setFetched("failed"),
    );
  }, [load, path]);
  useEffect(() => {
    if (!diff) ask();
  }, [diff, ask]);
  if (diff) return { status: "ready", diff };
  if (fetched === "failed") return { status: "failed", retry: ask };
  return fetched ? { status: "ready", diff: fetched } : { status: "loading" };
}

/** A diff on its way: a few lines breathing. */
function DiffSkeleton() {
  return (
    <div role="status" aria-label="Loading the diff" className="flex flex-col gap-1.5 px-3 py-2.5">
      {[72, 56, 64].map((width, i) => (
        <span
          key={width}
          className="breathe h-3 rounded-3 bg-hover"
          style={{ width: `${width}%`, animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex items-center gap-2 px-3 py-2.5 text-12 text-muted leading-[1.5]">
      {children}
    </p>
  );
}

const LINE = "grid grid-cols-[var(--number)_var(--number)_1fr] font-mono text-12 leading-[21px]";
const NUMBER = "select-none text-right text-faint";

/** A unified diff, syntax-neutral: tints for what was added and removed, stronger on the words. */
function Diff({ patch }: { patch: string }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  // The line numbers' columns fit the longest of them, and are never narrower than 40.
  const digits = Math.max(
    0,
    ...rows.map((r) => (r.kind === "line" ? String(Math.max(r.old ?? 0, r.new ?? 0)).length : 0)),
  );
  return (
    <div
      className="py-1.5 [tab-size:4]"
      style={{ "--number": `max(40px, calc(${digits}ch + 12px))` } as CSSProperties}
    >
      {rows.map((row, i) =>
        row.kind === "fold" ? (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a diff's rows are its order
            key={i}
            className={cn(LINE, "bg-hover text-faint")}
          >
            <span className={cn(NUMBER, "pr-2")}>⋯</span>
            <span />
            <span className="font-sans text-11">
              {row.lines} unchanged {row.lines === 1 ? "line" : "lines"}
            </span>
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff's rows are its order
          <DiffLine key={i} row={row} />
        ),
      )}
    </div>
  );
}

function DiffLine({ row }: { row: Extract<DiffRow, { kind: "line" }> }) {
  const tint = row.type === "add" ? "bg-diff-add" : row.type === "del" ? "bg-diff-del" : undefined;
  const bar =
    row.type === "add"
      ? "shadow-[inset_2px_0_0_var(--c-diff-add-bar)]"
      : row.type === "del"
        ? "shadow-[inset_2px_0_0_var(--c-diff-del-bar)]"
        : undefined;
  const word = row.type === "add" ? "bg-diff-add-word" : "bg-diff-del-word";
  return (
    <div className={cn(LINE, tint)}>
      <span className={cn(NUMBER, "pr-2", bar)}>{row.old ?? ""}</span>
      <span className={cn(NUMBER, "pr-3")}>{row.new ?? ""}</span>
      <span className="whitespace-pre-wrap pr-3 text-ink [overflow-wrap:anywhere]">
        {row.changed ? (
          <Marked text={row.text} spans={row.changed} className={word} />
        ) : (
          row.text || " "
        )}
        <span className="sr-only">
          {row.type === "add" ? " (added)" : row.type === "del" ? " (removed)" : ""}
        </span>
      </span>
    </div>
  );
}

/** A line's text with its changed words marked. */
function Marked({ text, spans, className }: { text: string; spans: Span[]; className: string }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of spans) {
    parts.push(text.slice(at, from));
    parts.push(
      <span key={from} className={cn("rounded-2", className)}>
        {text.slice(from, to)}
      </span>,
    );
    at = to;
  }
  parts.push(text.slice(at));
  return parts;
}
