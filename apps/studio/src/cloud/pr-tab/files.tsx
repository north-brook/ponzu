import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { type ReactNode, useMemo, useState } from "react";
import type { PrFile } from "../model.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { type DiffRow, isLarge, parsePatch } from "./diff.ts";

/** "+214 −38", in the pull request's colors. */
export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="ml-auto flex shrink-0 gap-1.5 font-mono font-normal text-12">
      <span className="text-pr-open">+{additions}</span>
      <span className="text-pr-failing">−{deletions}</span>
    </span>
  );
}

/** The changed files, each a card that opens to its diff. */
export function Files({
  files,
  additions,
  deletions,
  url,
  onOpenLink,
}: {
  files: PrFile[];
  additions: number;
  deletions: number;
  url: string;
  onOpenLink: (url: string) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <section aria-label="Files changed" className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center font-semibold text-11 text-faint">
        {files.length} {files.length === 1 ? "file" : "files"}
        <Counts additions={additions} deletions={deletions} />
      </div>
      {files.map((file) => (
        <FileCard
          key={file.path}
          file={file}
          open={open.has(file.path)}
          onToggle={() => toggle(file.path)}
          onOpenOnGithub={() => onOpenLink(`${url}/files`)}
        />
      ))}
    </section>
  );
}

function FileCard({
  file,
  open,
  onToggle,
  onOpenOnGithub,
}: {
  file: PrFile;
  open: boolean;
  onToggle: () => void;
  onOpenOnGithub: () => void;
}) {
  const id = `file-${file.path}`;
  return (
    <div className="overflow-hidden rounded-10 bg-surface shadow-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="flex h-9 w-full cursor-default items-center gap-2 rounded-10 px-3 text-left font-mono text-13 outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover"
      >
        <Icon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          size={12}
          stroke={2.2}
          className="text-icon-soft"
        />
        <span className="min-w-0 truncate">
          {file.previousPath ? <span className="text-faint">{file.previousPath} → </span> : null}
          {file.path}
        </span>
        {file.status === "added" || file.status === "removed" ? (
          <span className="shrink-0 font-sans text-11 text-faint">
            {file.status === "added" ? "new" : "deleted"}
          </span>
        ) : null}
        <Counts additions={file.additions} deletions={file.deletions} />
      </button>
      {open ? (
        <div id={id} className="border-rule border-t">
          <FileBody file={file} onOpenOnGithub={onOpenOnGithub} />
        </div>
      ) : null}
    </div>
  );
}

/** A file's diff, or why it isn't shown: binary, too large for GitHub, or large enough to ask. */
function FileBody({ file, onOpenOnGithub }: { file: PrFile; onOpenOnGithub: () => void }) {
  const [forced, setForced] = useState(false);
  if (file.binary) return <Quiet>Binary file, not shown.</Quiet>;
  if (file.patch === null) {
    return (
      <Quiet>
        GitHub doesn't show a diff this large.
        <Button variant="quiet" onClick={onOpenOnGithub} className="-my-1 px-2 text-ink">
          Open on GitHub
        </Button>
      </Quiet>
    );
  }
  if (isLarge(file) && !forced) {
    return (
      <Quiet>
        {(file.additions + file.deletions).toLocaleString("en-US")} changed lines.
        <Button variant="quiet" onClick={() => setForced(true)} className="-my-1 px-2 text-ink">
          Show diff
        </Button>
      </Quiet>
    );
  }
  return <Diff patch={file.patch} />;
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex items-center gap-2 px-3 py-2.5 text-12 text-muted leading-[1.5]">
      {children}
    </p>
  );
}

const LINE = "grid grid-cols-[40px_40px_1fr] font-mono text-12 leading-[21px]";
const NUMBER = "select-none text-right text-faint";

/** A unified diff, syntax-neutral: tints for what was added and removed, stronger on the words. */
function Diff({ patch }: { patch: string }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  return (
    <div className="py-1.5">
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
  const [from, to] = row.changed ?? [0, 0];
  return (
    <div className={cn(LINE, tint)}>
      <span className={cn(NUMBER, "pr-2", bar)}>{row.old ?? ""}</span>
      <span className={cn(NUMBER, "pr-3")}>{row.new ?? ""}</span>
      <span className="whitespace-pre-wrap pr-3 text-ink [overflow-wrap:anywhere]">
        {row.changed ? (
          <>
            {row.text.slice(0, from)}
            <span className={cn("rounded-2", word)}>{row.text.slice(from, to)}</span>
            {row.text.slice(to)}
          </>
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
