import type { Catalog, CatalogFile, CatalogMachine } from "@ponzu/core";
import { Icon, timeAgo } from "@ponzu/react";
import { cn } from "@/lib/utils";

/** The catalog's entry for a design, by its key and the server in front of it. */
export function fileOf(
  catalog: Catalog | null,
  target: { key: string; base: string },
): CatalogFile | undefined {
  return catalog?.files.find((f) => f.key === target.key && f.base === target.base);
}

/** A path with the home folder as ~. */
export function tilde(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

/** The folder a design is worked on in: its git checkout, or the folder it's in. */
export function folderOf(file: Pick<CatalogFile, "key" | "git">): string {
  return file.git?.root ?? (file.key.slice(0, file.key.lastIndexOf("/")) || "/");
}

/** The branch checked out, or the commit a detached HEAD is at. */
export function branchOf(file: Pick<CatalogFile, "git">): string | undefined {
  return file.git?.branch ?? file.git?.commit;
}

/** What the project filter groups by: the repository, shared by its checkouts and Macs. */
export function projectOf(file: Pick<CatalogFile, "git">): { id: string; name: string } | null {
  const g = file.git;
  if (!g) return null;
  const id = g.project ?? g.root;
  return { id, name: g.projectName ?? id.split("/").pop() ?? id };
}

export function Device({ machine }: { machine?: CatalogMachine }) {
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

/**
 * Where a design lives, in one quiet line: the branch it's on, or for a design
 * outside git, the folder it's in. The full path is its tooltip.
 */
export function WhereLine({ file, className }: { file: CatalogFile; className?: string }) {
  const branch = branchOf(file);
  const label = branch ?? tilde(folderOf(file));
  return (
    <span
      className={cn("flex min-w-0 items-center gap-[5px] text-muted-foreground text-xs", className)}
      title={tilde(file.key)}
    >
      <Icon
        name={branch ? "branch" : "folder"}
        size={13}
        strokeWidth={1.7}
        className="shrink-0 text-faint"
      />
      {/* A folder reads from the right, so a long one keeps its end. */}
      <span className="min-w-0 truncate" dir={branch ? undefined : "rtl"}>
        <bdi>{label}</bdi>
      </span>
    </span>
  );
}

/**
 * Everything the catalog knows about a design: the project and branch it's on
 * (or for one outside git, the folder it's in), which Mac it's on and when it
 * last changed. The full path is the name's tooltip. Read-only.
 */
export function FileDetails({
  file,
  name,
  machine,
}: {
  file?: CatalogFile;
  /** The design's name, for one the catalog doesn't list (yet). */
  name?: string;
  machine?: CatalogMachine;
}) {
  const project = file && projectOf(file);
  const branch = file && branchOf(file);
  const folder = file && !project && folderOf(file);
  return (
    <div className="flex flex-col gap-2.5">
      <b className="truncate font-semibold text-[14px]" title={file && tilde(file.key)}>
        {file?.name ?? name}
      </b>
      {(project || folder) && (
        <div className="flex flex-col gap-1">
          {project && <Where icon="repo" label={repoOf(project)} title={tilde(project.id)} />}
          {branch && (
            <Where
              icon="branch"
              label={branch}
              title={file?.git?.branch ? branch : `Detached at ${branch}`}
            />
          )}
          {folder && <Where icon="folder" label={tilde(folder)} title={tilde(folder)} fromEnd />}
        </div>
      )}
      {file?.locked && (
        <span className="text-muted-foreground text-xs">
          Open it to let Ponzu read this folder.
        </span>
      )}
      <div className="flex items-center gap-[5px] whitespace-nowrap border-t pt-2.5 text-muted-foreground text-xs">
        <Device machine={machine} />
        {file?.modified ? (
          <>
            <span className="text-faint">·</span>
            {ago(file.modified)}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** One line of where a design is: its repository, branch or folder. */
function Where({
  icon,
  label,
  title,
  fromEnd,
}: {
  icon: string;
  label: string;
  title?: string;
  /** A folder reads from the right, so a long one keeps its end. */
  fromEnd?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-[5px] text-xs" title={title}>
      <Icon name={icon} size={13} strokeWidth={1.7} className="shrink-0 text-faint" />
      <span className="min-w-0 truncate" dir={fromEnd ? "rtl" : undefined}>
        <bdi>{label}</bdi>
      </span>
    </span>
  );
}

/**
 * A project as its host shows it, e.g. "north-brook/ponzu", or for one with no
 * remote, its folder's name.
 */
export function repoOf(project: { id: string; name: string }): string {
  return project.id.startsWith("/") ? project.name : project.id.slice(project.id.indexOf("/") + 1);
}

export function ago(ms: number): string {
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

/** The same, shorter, for the corner of a card: "now", "12m", "3h", "2d", "Oct 9". */
export function agoShort(ms: number): string {
  if (!ms) return "";
  const t = timeAgo(ms);
  if (t === "now") return "now";
  if (/^\d+[mhd]$/.test(t) && !(t.endsWith("d") && Number(t.slice(0, -1)) >= 7)) return t;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
