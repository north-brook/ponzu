import {
  type Catalog,
  type CatalogArtboard,
  type CatalogCard,
  type CatalogFile,
  type CatalogMachine,
  foldCopies,
  type Idea,
  previewArtboard,
  STARTED_FOR,
  settled,
  startedFrom,
  viewOf,
  withoutUntouched,
} from "@ponzu/core";
import {
  ArtboardView,
  Icon,
  Rain,
  SocketSource,
  Tip,
  TipProvider,
  useDelayed,
  useSource,
} from "@ponzu/react";
import Fuse, { type FuseResultMatch } from "fuse.js";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { agoShort, branchOf, folderOf, projectOf, tilde, WhereLine } from "@/components/file-info";
import { LookingCard, SuggestionCard, SuggestionDialog, Thinking } from "@/components/suggested";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isUnseen, type Seen } from "@/lib/seen";
import { ideaKey, useElsewhere, useSuggestions } from "@/lib/suggestions";
import { cn } from "@/lib/utils";

/** What opening a design needs: its key on its own Mac, and the server path in front of it. */
export interface OpenTarget {
  key: string;
  base: string;
}

const mac = navigator.userAgent.includes("Mac");
const mod = mac ? "⌘" : "Ctrl+";

/** How wide the rain runs on a card that has no preview yet. */
const RAIN_COLUMNS = 8;
/** How wide the rain runs beside the name of a card an agent is working in. */
const CARD_RAIN_COLUMNS = 12;
/** Cards shown live at once. Each holds its design's first page in the page. */
const LIVE_CARDS = 4;
/** How long a card stays live after its agent stops: about as long as its preview takes to redraw. */
const LIVE_LINGER = 10_000;

/**
 * The home screen: every design on this Mac and the person's other Macs, newest
 * first, with search over files and their frames, and designs the person's agent
 * suggests for their recent projects. Until Recent has a design, Suggested is
 * the open tab.
 */
export function Dashboard({
  catalog,
  onOpen,
  onOpenFolder,
  onNew,
  onShelve,
  seen = {},
}: {
  catalog: Catalog | null;
  /** When the person last looked at each design: one changed since wears a dot. */
  seen?: Seen;
  onOpen: (target: OpenTarget) => void;
  onOpenFolder?: () => void;
  onNew?: () => void;
  /** Archive or restore a design. Resolves once it's done. */
  onShelve?: (file: CatalogFile, action: ShelfAction) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  /** The view the person picked; until they pick one, Recent, or Suggested while Recent is empty. */
  const [picked, setPicked] = useState<View | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const search = useRef<HTMLInputElement>(null);

  // ⌘F (Ctrl+F off a Mac) goes to search; with any other modifier it's some other shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const plain = e.metaKey === mac && e.ctrlKey === !mac && !e.shiftKey && !e.altKey;
      if (plain && e.key.toLowerCase() === "f") {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A worktree's copy nobody touched is the main checkout's design: no card of its own.
  const files = useMemo(() => withoutUntouched(catalog?.files ?? []), [catalog?.files]);
  const q = query.trim();
  const live = useLive(files);
  // Identical copies of a design in several checkouts are one card.
  const shelved = useMemo(() => {
    const by: Record<Shelf, CatalogFile[]> = { recent: [], archived: [] };
    for (const f of files) by[viewOf(f)].push(f);
    return { recent: foldCopies(by.recent), archived: foldCopies(by.archived) };
  }, [files]);
  const empty = catalog !== null && shelved.recent.length === 0;
  // Designs missing from both shelves, not just Recent: an archive alone is a catalog that came.
  const waiting = useSetUp(catalog !== null, catalog !== null && files.length === 0);

  // Suggested shows with an agent to ask. It looks again each time it's opened.
  const [looking, setLooking] = useState(false);
  // Installing an agent while the home screen is open brings Suggested in without a restart.
  const installed =
    catalog?.agents
      .filter((a) => a.found)
      .map((a) => a.id)
      .join(" ") ?? "";
  const suggestions = useSuggestions(looking, installed);
  // The person's other Macs suggest for their own projects, each card naming its Mac.
  const macs = useMemo(
    () => catalog?.machines.filter((m) => m.id !== "local") ?? [],
    [catalog?.machines],
  );
  const elsewhere = useElsewhere(looking, macs);
  const suggest = Boolean(suggestions?.agent) || elsewhere.length > 0;
  const view: View =
    picked === "suggested" && !suggest
      ? "recent"
      : (picked ?? (empty && suggest ? "suggested" : "recent"));
  const loading = catalog === null || waiting || (empty && suggestions === null);
  const open = !loading && !q && view === "suggested";
  useEffect(() => setLooking(open), [open]);
  // An idea the person started shows as its design in its place while the design is new, and
  // then lives in Recent alone. The catalog may not change when it settles, so the clock wakes
  // at the next design's deadline.
  const [clock, setClock] = useState(() => Date.now());
  const ideas = useMemo(() => {
    const now = Math.max(clock, Date.now());
    // Each Mac's ideas are started by a design on that Mac.
    const of = (ideas: readonly Idea[], machine?: CatalogMachine) => {
      const there = files.filter((f) => f.machine === (machine?.id ?? "local"));
      return ideas.flatMap((idea) => {
        const file = startedFrom(idea, there);
        return file && settled(file, now) ? [] : [{ idea, file, machine }];
      });
    };
    return [...of(suggestions?.ideas ?? []), ...elsewhere.flatMap((e) => of(e.ideas, e.machine))];
  }, [suggestions?.ideas, elsewhere, files, clock]);
  useEffect(() => {
    const due = ideas.flatMap(({ file }) =>
      file?.created && !file.busy ? [file.created + STARTED_FOR] : [],
    );
    if (!due.length) return;
    const t = setTimeout(
      () => setClock(Date.now()),
      Math.max(0, Math.min(...due) - Date.now()) + 50,
    );
    return () => clearTimeout(t);
  }, [ideas]);
  const [idea, setIdea] = useState<{
    idea: Idea | null;
    machine?: CatalogMachine;
    open: boolean;
  }>({ idea: null, open: false });
  // The picked idea as it is now: its prompt may still be on its way.
  const chosen = idea.idea;
  const chosenNow = chosen
    ? (ideas.find((i) => i.machine?.id === idea.machine?.id && ideaKey(i.idea) === ideaKey(chosen))
        ?.idea ?? chosen)
    : null;

  // Searching looks everywhere but the archive.
  const searchable = shelved.recent;
  const inView = view === "suggested" ? NO_CARDS : shelved[view];
  const refs = useMemo(
    () =>
      view === "suggested"
        ? [
            ...ideas.map(({ idea }) => idea),
            ...(suggestions?.looking ?? []),
            ...elsewhere.flatMap((e) => e.looking),
          ].map((i) => ({ id: i.projectId, name: i.projectName }))
        : inView.map((c) => projectOf(c.file)),
    [view, ideas, inView, suggestions?.looking, elsewhere],
  );
  const projects = useProjects(refs);
  // A filter for a project this view no longer has goes back to All.
  // NO_PROJECT is "", a scope like any other: compare with null, not truthiness.
  const scope = project !== null && projects.some((p) => p.id === project) ? project : null;
  const shown =
    scope !== null ? inView.filter((c) => (projectOf(c.file)?.id ?? NO_PROJECT) === scope) : inView;
  const suggested = scope !== null ? ideas.filter(({ idea }) => idea.projectId === scope) : ideas;
  // Projects a run is still looking around, each a card until its ideas come.
  const around = [
    ...(suggestions?.looking ?? []).map((at) => ({ at, machine: undefined })),
    ...elsewhere.flatMap((e) => e.looking.map((at) => ({ at, machine: e.machine }))),
  ].filter(({ at }) => scope === null || at.projectId === scope);
  const running = Boolean(suggestions?.running) || elsewhere.some((e) => e.running);

  // A shelf change that fails (another Mac offline, a newer Ponzu owning the catalog)
  // says why in the toast, and the card stays as it was.
  const failed = (err: unknown) =>
    setToast({ text: err instanceof Error && err.message ? err.message : "That didn’t work." });
  // A card's copies go with it, so archiving one doesn't turn up the next.
  const shelve = onShelve
    ? async (card: CatalogCard, action: ShelfAction) => {
        const all = (a: ShelfAction) =>
          Promise.all([card.file, ...card.copies].map((f) => onShelve(f, a)));
        try {
          await all(action);
        } catch (err) {
          failed(err);
          return;
        }
        const undo: Record<ShelfAction, ShelfAction> = { archive: "restore", restore: "archive" };
        setToast({
          text: TOAST[action](card.file.name),
          undo: () => {
            setToast(null);
            all(undo[action]).catch(failed);
          },
        });
      }
    : undefined;
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

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
                  if (e.key === "Escape") {
                    setQuery("");
                    e.currentTarget.blur();
                  }
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
                <span className="text-faint text-xs">{mod}F</span>
              )}
            </label>
            <span className="w-1.5" />
            {onOpenFolder && (
              <IconButton label="Open" keys={["⌘", "O"]} icon="folderOpen" onClick={onOpenFolder} />
            )}
            {onNew && <IconButton label="New" keys={["⌘", "N"]} icon="add" onClick={onNew} />}
          </div>
        </TipProvider>

        {loading ? (
          <Loading />
        ) : q ? (
          <Results
            query={q}
            cards={searchable}
            onOpen={onOpen}
            onShelve={shelve}
            live={live}
            seen={seen}
          />
        ) : (
          <>
            {/* One row: the views at the left, the project at the right. */}
            <div className="-mb-3.5 flex h-7 items-center justify-between gap-4">
              <Views
                view={view}
                has={{
                  recent: true,
                  suggested: suggest,
                  archived: shelved.archived.length > 0,
                }}
                onView={setPicked}
              />
              {projects.length > 1 && (
                <Projects projects={projects} scope={scope} onScope={setProject} />
              )}
            </div>
            {view === "suggested" ? (
              suggested.length || around.length ? (
                <Grid>
                  {around.map(({ at, machine }) => (
                    <LookingCard
                      key={`looking:${machine?.id ?? "local"}:${at.project}`}
                      at={at}
                      machine={machine}
                    />
                  ))}
                  {suggested.map(({ idea, file, machine }) =>
                    file ? (
                      // Started: the design in the idea's place, while it's new.
                      <FileCard
                        key={file.id}
                        card={{ file, copies: [] }}
                        onOpen={onOpen}
                        onShelve={shelve}
                        live={live.has(file.id)}
                        unseen={isUnseen(seen, file)}
                      />
                    ) : (
                      <SuggestionCard
                        key={`${machine?.id ?? "local"}:${idea.project}:${idea.name}`}
                        idea={idea}
                        machine={machine}
                        onPick={(idea) => setIdea({ idea, machine, open: true })}
                      />
                    ),
                  )}
                </Grid>
              ) : running ? (
                <Thinking />
              ) : (
                <p className="mt-6 text-center text-muted-foreground">{EMPTY[view]}</p>
              )
            ) : shown.length ? (
              <Grid>
                {shown.map((c) => (
                  <FileCard
                    key={c.file.id}
                    card={c}
                    onOpen={onOpen}
                    onShelve={shelve}
                    live={live.has(c.file.id)}
                    unseen={isUnseen(seen, c.file)}
                    short={Boolean(scope)}
                  />
                ))}
              </Grid>
            ) : (
              <p className="mt-6 text-center text-muted-foreground">{EMPTY[view]}</p>
            )}
          </>
        )}
      </div>
      {toast && <Toast text={toast.text} onUndo={toast.undo} onClose={() => setToast(null)} />}
      <SuggestionDialog
        idea={chosenNow}
        machine={idea.machine}
        agent={
          (idea.machine
            ? elsewhere.find((e) => e.machine.id === idea.machine?.id)?.agent
            : suggestions?.agent) ?? null
        }
        open={idea.open}
        onClose={() => setIdea((i) => ({ ...i, open: false }))}
      />
    </div>
  );
}

/**
 * Which designs the home screen lists: what the person or an agent touched
 * lately, or everything put away (by the person, by going idle, or made by an
 * agent for its own use).
 */
type Shelf = "recent" | "archived";

/** The home screen's tabs: the shelves, and designs the person's agent suggests. */
type View = Shelf | "suggested";

export type ShelfAction = "archive" | "restore";

const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "recent", label: "Recent", icon: "clock" },
  { id: "suggested", label: "Suggested", icon: "sparkle" },
  { id: "archived", label: "Archived", icon: "shelved" },
];

const EMPTY: Record<View, string> = {
  recent: "Nothing here yet.",
  suggested: "Nothing to suggest yet.",
  archived: "Nothing archived.",
};

const TOAST: Record<ShelfAction, (name: string) => string> = {
  archive: (n) => `Archived “${n}”. It comes back when you open it or an agent edits it.`,
  restore: (n) => `Restored “${n}”.`,
};

/** Suggested lists ideas, not designs. */
const NO_CARDS: CatalogCard[] = [];

/** The chip for designs outside any git checkout. */
const NO_PROJECT = "";

function Views({
  view,
  has,
  onView,
}: {
  view: View;
  /** Which views have something in them. */
  has: Record<View, boolean>;
  onView: (view: View) => void;
}) {
  return (
    <div className="flex items-center gap-[18px] text-[13px]" role="tablist">
      {VIEWS.map((v) =>
        // Suggested shows with an agent to ask; Archived once there's something in it, or while
        // it's open.
        has[v.id] || view === v.id ? (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => onView(v.id)}
            className={cn(
              "group flex items-center gap-1.5",
              view === v.id
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon
              name={v.icon}
              size={14}
              className={
                view === v.id ? "text-foreground" : "text-faint group-hover:text-muted-foreground"
              }
            />
            {v.label}
          </button>
        ) : null,
      )}
    </div>
  );
}

interface Project {
  id: string;
  name: string;
  count: number;
}

/** The projects in a view, the busiest first, and the designs outside one last. */
function useProjects(refs: ({ id: string; name: string } | null)[]): Project[] {
  return useMemo(() => {
    const by = new Map<string, Project>();
    for (const p of refs) {
      const id = p?.id ?? NO_PROJECT;
      const had = by.get(id);
      if (had) had.count++;
      else by.set(id, { id, name: p?.name ?? "Not in a project", count: 1 });
    }
    // Two projects with the same short name say which owner each is.
    const names = new Map<string, number>();
    for (const p of by.values()) names.set(p.name, (names.get(p.name) ?? 0) + 1);
    for (const p of by.values())
      if (p.id !== NO_PROJECT && (names.get(p.name) ?? 0) > 1)
        p.name = p.id.split("/").slice(-2).join("/");
    return [...by.values()].sort(
      (a, b) =>
        Number(a.id === NO_PROJECT) - Number(b.id === NO_PROJECT) ||
        b.count - a.count ||
        a.name.localeCompare(b.name),
    );
  }, [refs]);
}

function Projects({
  projects,
  scope,
  onScope,
}: {
  projects: Project[];
  scope: string | null;
  onScope: (id: string | null) => void;
}) {
  const on = projects.find((p) => p.id === scope);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Project: ${on ? on.name : "All projects"}`}
          className={cn(
            "flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[7px] pr-2 pl-2.5 text-[13px] outline-none hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)] data-[state=open]:bg-accent",
            // Like the view tabs: all projects stays muted, a chosen one lights up.
            on
              ? "font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground data-[state=open]:text-foreground",
          )}
        >
          <Icon
            name={!on ? "folders" : on.id === NO_PROJECT ? "loose" : "folder"}
            size={14}
            strokeWidth={1.6}
            className={on ? "text-foreground" : undefined}
          />
          {on ? on.name : "All projects"}
          <Icon name="chevronDown" size={13} strokeWidth={2} className="text-faint" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <ProjectItem on={scope === null} onSelect={() => onScope(null)} icon="folders">
          All projects
        </ProjectItem>
        <DropdownMenuSeparator />
        {projects.map((p) => (
          <ProjectItem
            key={p.id}
            on={scope === p.id}
            onSelect={() => onScope(p.id)}
            icon={p.id === NO_PROJECT ? "loose" : "folder"}
            title={p.id || undefined}
          >
            {p.name}
          </ProjectItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectItem({
  on,
  onSelect,
  icon,
  title,
  children,
}: {
  on: boolean;
  onSelect: () => void;
  icon?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} title={title} aria-checked={on} role="menuitemcheckbox">
      <span className="grid w-3.5 place-items-center">
        {on && <Icon name="check" size={14} strokeWidth={2} />}
      </span>
      <span className="grid w-3.5 place-items-center text-muted-foreground">
        {icon && <Icon name={icon} size={14} strokeWidth={1.6} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </DropdownMenuItem>
  );
}

/** Remembers that this Mac has had designs: its own, or its other Macs'. */
const SET_UP_KEY = "ponzu.setUp";
/**
 * How long a Mac that had designs waits for them before showing an empty Recent after all.
 * Long enough for another Mac restarting for the same update to come back and be linked again.
 */
const SET_UP_GRACE = 30_000;

/**
 * Whether to show placeholder cards rather than an empty Recent: this Mac has had designs, in
 * this session or an earlier one, and has had none, archived or not, for less than the grace
 * period. A
 * catalog read while an update restarts can come back empty, or, on a Mac whose designs are all
 * on the person's other Macs, before those Macs are linked again; it waits for them. One still
 * empty after the grace period is really empty (every design deleted, the other Macs off), so
 * Suggested opens then.
 */
function useSetUp(arrived: boolean, setup: boolean): boolean {
  const [had, setHad] = useState(() => {
    try {
      return localStorage.getItem(SET_UP_KEY) === "1";
    } catch {
      return false;
    }
  });
  /** When the designs went missing from a catalog that arrived; null while they're there. */
  const [missingSince, setMissingSince] = useState<number | null>(null);
  const [, setNow] = useState(0);
  const past = arrived && !setup;
  useEffect(() => {
    if (!past) return;
    setHad(true);
    try {
      localStorage.setItem(SET_UP_KEY, "1");
    } catch {}
  }, [past]);
  useEffect(() => {
    setMissingSince((at) => (setup ? (at ?? Date.now()) : null));
  }, [setup]);
  useEffect(() => {
    if (missingSince === null) return;
    const t = setTimeout(() => setNow(Date.now()), missingSince + SET_UP_GRACE - Date.now());
    return () => clearTimeout(t);
  }, [missingSince]);
  if (!had || !setup) return false;
  // Before the effect above notes when it emptied, it's only just emptied.
  return missingSince === null || Date.now() - missingSince < SET_UP_GRACE;
}

/** Name and project widths for the placeholder cards, so they don't read as one card repeated. */
const LOADING_NAMES = ["62%", "48%", "71%", "55%", "44%", "66%", "52%", "60%"];
const LOADING_PROJECTS = ["34%", "26%", "40%", "30%", "24%", "36%", "28%", "32%"];

/**
 * The catalog on its way: the first snapshot waits a moment for the person's other Macs.
 * The Recent tab and placeholder cards laid out like the real ones, not an empty Recent that
 * then fills. Nothing at all for a wait too short to notice.
 */
function Loading() {
  const shown = useDelayed(true);
  if (!shown) return null;
  return (
    <div className="pz-appear flex flex-col gap-7" role="status" aria-label="Loading designs">
      <div className="-mb-3.5 flex h-7 items-center text-[13px]">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <Icon name="clock" size={14} className="text-foreground" />
          Recent
        </span>
      </div>
      <Grid>
        {LOADING_NAMES.map((w, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
            key={i}
            className="flex flex-col gap-2.5 motion-safe:animate-pulse"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <div className="aspect-[16/11] rounded-xl bg-preview shadow-[0_0_0_1px_var(--hairline)]" />
            {/* The name and when, then the project and branch, each where the card has it. */}
            <div className="flex flex-col gap-0.5 px-0.5">
              <span className="flex h-5 items-center gap-2">
                <span className="flex-1">
                  <span className="block h-[11px] rounded-full bg-secondary" style={{ width: w }} />
                </span>
                <span className="h-[9px] w-5 rounded-full bg-secondary" />
              </span>
              <span className="flex h-4 items-center gap-[5px]">
                <span className="size-[11px] shrink-0 rounded-[3px] bg-secondary" />
                <span
                  className="h-[9px] rounded-full bg-secondary"
                  style={{ width: LOADING_PROJECTS[i] }}
                />
                <span className="size-[11px] shrink-0 rounded-[3px] bg-secondary" />
                <span className="h-[9px] w-[22%] rounded-full bg-secondary" />
              </span>
            </div>
          </div>
        ))}
      </Grid>
    </div>
  );
}

function Toast({
  text,
  onUndo,
  onClose,
}: {
  text: string;
  onUndo?: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex h-10 -translate-x-1/2 items-center gap-3.5 rounded-xl bg-foreground pr-2 pl-3.5 text-[13px] text-home shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_28px_rgba(0,0,0,0.1)]"
    >
      <span>{text}</span>
      {onUndo ? (
        <button
          type="button"
          onClick={onUndo}
          className="flex h-7 items-center rounded-lg bg-home/15 px-2.5 font-medium hover:bg-home/25"
        >
          Undo
        </button>
      ) : (
        <button type="button" aria-label="Dismiss" onClick={onClose} className="px-1.5 opacity-70">
          <Icon name="close" size={13} />
        </button>
      )}
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
        className="grid size-10 place-items-center rounded-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon name={icon} size={20} strokeWidth={1.5} />
      </button>
    </Tip>
  );
}

function agentName(client?: string): string {
  if (client === "claude") return "Claude";
  if (client === "openai") return "Codex";
  if (client === "cursor") return "Cursor";
  return "Your agent";
}

/* ------------------------------------------------------------------ */
/* Files                                                              */
/* ------------------------------------------------------------------ */

function Heading({ left }: { left: string }) {
  return <div className="-mb-3.5 text-muted-foreground text-xs">{left}</div>;
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
  card,
  onOpen,
  onShelve,
  match,
  pathMatch,
  live,
  unseen,
  short,
}: {
  card: CatalogCard;
  onOpen: (target: OpenTarget) => void;
  onShelve?: (card: CatalogCard, action: ShelfAction) => Promise<void>;
  /** Show the design itself, edits and all, over its preview. */
  live?: boolean;
  /** Changed since the person last looked: the yuzu dot. */
  unseen?: boolean;
  match?: readonly [number, number][];
  /** Where a search matched the file's path, when it matched there and not in the name. */
  pathMatch?: readonly [number, number][];
  /** Filtered to its project: the folder line can say less. */
  short?: boolean;
}) {
  const { file, copies } = card;
  // Only an agent at work in it, as its tab has it: a design just made isn't one.
  const working = Boolean(file.busy);
  const archived = viewOf(file) === "archived";
  const open = () => onOpen({ key: file.key, base: file.base });
  const body = (
    // A div, not a button: a button can't hold the preview's divs.
    // biome-ignore lint/a11y/useSemanticElements: holds block content
    <div
      role="button"
      tabIndex={0}
      className="group relative flex min-w-0 cursor-default flex-col gap-2.5 text-left outline-none"
      onClick={open}
      onKeyDown={(e) => {
        // Only the card's own keys: the menu's, portaled but still in this tree, bubble here.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      title={file.locked ? "Open it to let Ponzu read this folder." : undefined}
    >
      <div className="relative aspect-[16/11] overflow-hidden rounded-xl bg-preview shadow-[0_0_0_1px_var(--hairline)] transition-shadow group-hover:shadow-[0_0_0_1px_var(--hairline-strong),0_4px_14px_rgba(0,0,0,0.06)] group-focus-visible:shadow-[0_0_0_2px_var(--ring)]">
        <div className={cn("absolute inset-0", archived && "opacity-55 grayscale")}>
          <Preview src={file.preview} working={working} />
          {live && <LivePreview file={file} />}
        </div>
        {unseen && (
          <span
            role="img"
            aria-label="Changed since you looked"
            title="Changed since you looked"
            className="absolute top-2 left-2 z-[4] size-2.5 rounded-full bg-flesh shadow-[0_0_0_1.5px_var(--card),0_0_0_2.5px_rgba(17,17,16,0.18)]"
          />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium text-[13.5px]",
              working && "pz-shimmer",
              archived && "text-muted-foreground",
            )}
          >
            <Highlight text={file.name} ranges={match} />
          </span>
          <span
            className="shrink-0 text-faint text-xs tabular-nums"
            title={
              archived && file.archived
                ? `Archived ${new Date(file.archived).toLocaleString()}`
                : undefined
            }
          >
            {/* While an agent edits it, yuzu rain stands in for "now". */}
            {file.busy ? (
              <Rain
                columns={CARD_RAIN_COLUMNS}
                className="self-center text-[17px]"
                label={`${agentName(file.busy)} is working`}
                title={`${agentName(file.busy)} is working`}
              />
            ) : (
              agoShort(file.modified)
            )}
          </span>
        </span>
        {archived && !pathMatch ? (
          <ArchivedFor file={file} />
        ) : pathMatch ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground" dir="rtl">
            {/* Right to left, so a long path keeps its end; the marks stay on their letters. */}
            <bdi>
              <Highlight text={file.key} ranges={pathMatch} />
            </bdi>
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-[5px] text-muted-foreground text-xs">
            {copies.length ? (
              <Checkouts card={card} />
            ) : (
              <WhereLine file={file} project={!short} className="min-w-0 shrink" />
            )}
            {short && file.git && !copies.length && (
              <>
                <span className="text-faint">·</span>
                <span className="min-w-0 shrink-[2] truncate">
                  {folderOf(file).split("/").pop()}
                </span>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
  if (!onShelve) return body;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{body}</ContextMenuTrigger>
      {/* Portaled, but its clicks still bubble to the card, which would open it. */}
      <ContextMenuContent onClick={(e) => e.stopPropagation()}>
        <CardMenuItems card={card} onOpen={onOpen} onShelve={onShelve} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Why an archived card is archived, in the line its folder takes in Recent. */
function ArchivedFor({ file }: { file: CatalogFile }) {
  const [icon, text] =
    file.archivedFor === "idle"
      ? ["clock", `Not opened since ${since(file.active ?? file.modified)}`]
      : file.archivedFor === "scratch" || file.shelf === "scratch"
        ? ["bot", "Made by an agent"]
        : file.archivedFor === "temp"
          ? ["bot", "In a temporary folder"]
          : ["shelved", "You archived it"];
  return (
    <span
      className="flex min-w-0 items-center gap-[5px] text-muted-foreground text-xs"
      title={file.archived ? `Archived ${new Date(file.archived).toLocaleString()}` : undefined}
    >
      <Icon name={icon} size={13} strokeWidth={1.7} className="shrink-0 text-faint" />
      <span className="truncate">{text}</span>
    </span>
  );
}

/** "Oct 9", or "Oct 9, 2025" from another year. */
function since(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Where a card's copies are, all of them, with none picked out: "9 branches". */
function Checkouts({ card }: { card: CatalogCard }) {
  const all = labelled(card);
  const branches = [card.file, ...card.copies].every((f) => f.git?.branch);
  return (
    <span
      className="flex min-w-0 items-center gap-[5px] text-muted-foreground text-xs"
      title={`The same design, unchanged, on ${all.map((c) => c.label).join(", ")}`}
    >
      <Icon name="branch" size={13} strokeWidth={1.7} className="shrink-0 text-faint" />
      <span className="truncate">
        {all.length} {branches ? "branches" : "checkouts"}
      </span>
    </span>
  );
}

/** A card's design and its copies, each with the branch (or folder) it's on, in name order. */
function labelled(card: CatalogCard): { file: CatalogFile; label: string }[] {
  return [card.file, ...card.copies]
    .map((file) => ({ file, label: branchOf(file) ?? tilde(folderOf(file)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The card's right-click menu: open it (on any of its branches), find it, or put it away. */
function CardMenuItems({
  card,
  onOpen,
  onShelve,
}: {
  card: CatalogCard;
  onOpen: (target: OpenTarget) => void;
  onShelve: (card: CatalogCard, action: ShelfAction) => Promise<void>;
}) {
  const { file, copies } = card;
  const desktop = window.ponzuDesktop;
  const here = file.machine === "local";
  return (
    <>
      <ContextMenuItem onSelect={() => onOpen({ key: file.key, base: file.base })}>
        <Icon name="folderOpen" size={15} />
        Open
      </ContextMenuItem>
      {copies.length > 0 && (
        <>
          <ContextMenuSeparator />
          <div className="px-2.5 pt-1 pb-0.5 text-[11.5px] text-faint">Open on</div>
          <div className="max-h-[225px] overflow-y-auto">
            {labelled(card).map(({ file: c, label }) => (
              <ContextMenuItem
                key={c.id}
                title={tilde(c.key)}
                onSelect={() => onOpen({ key: c.key, base: c.base })}
              >
                <Icon name="branch" size={15} />
                <span className="min-w-0 max-w-[240px] truncate">{label}</span>
              </ContextMenuItem>
            ))}
          </div>
          <ContextMenuSeparator />
        </>
      )}
      {desktop && here && (
        <ContextMenuItem onSelect={() => desktop.reveal(file.key)}>
          <Icon name="folder" size={15} />
          Show in Finder
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(file.key)}>
        <Icon name="copy" size={15} />
        Copy path
      </ContextMenuItem>
      <ContextMenuSeparator />
      {viewOf(file) === "archived" ? (
        <ContextMenuItem onSelect={() => void onShelve(card, "restore")}>
          <Icon name="unarchive" size={15} />
          Restore
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onSelect={() => void onShelve(card, "archive")}>
          <Icon name="shelved" size={15} />
          Archive
        </ContextMenuItem>
      )}
    </>
  );
}

/**
 * The canvas preview, or an empty canvas while it's drawn (or when there's
 * none): yuzu rain while an agent is at it, a blank page otherwise. Previews
 * are drawn on the light and the dark canvas; the studio's theme follows the
 * system's, and so does the one shown.
 */
function Preview({ src, working }: { src: string | null; working?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed)
    return (
      <span className="absolute inset-0 grid place-items-center text-faint">
        {working ? (
          <Rain columns={RAIN_COLUMNS} className="text-[30px]" />
        ) : (
          <Icon name="blank" size={28} strokeWidth={1.3} />
        )}
      </span>
    );
  return (
    <picture>
      <source srcSet={`${src}&theme=dark`} media="(prefers-color-scheme: dark)" />
      <img
        src={src}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className="absolute inset-0 size-full object-contain"
      />
    </picture>
  );
}

/**
 * Which cards are live: the first few an agent is working in, and each for a
 * little while after it stops, until its preview has caught up with what it did.
 */
function useLive(files: CatalogFile[]): Set<string> {
  const busy = useRef(new Set<string>());
  const until = useRef(new Map<string, number>());
  const [, wake] = useState(0);
  const now = Date.now();
  for (const f of files) {
    if (f.busy) {
      busy.current.add(f.id);
      until.current.delete(f.id);
    } else if (busy.current.delete(f.id)) {
      // The first catalog that shows the agent gone starts the linger.
      until.current.set(f.id, now + LIVE_LINGER);
    }
  }
  const live = new Set<string>();
  for (const f of files) {
    if (live.size === LIVE_CARDS) break;
    if (f.busy || (until.current.get(f.id) ?? 0) > now) live.add(f.id);
  }
  // The catalog changes only when something does; a lingering card ends on time without it.
  const next = Math.min(
    ...[...live].map((id) => until.current.get(id) ?? 0).filter((t) => t > now),
  );
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const t = setTimeout(() => wake((n) => n + 1), next - Date.now() + 50);
    return () => clearTimeout(t);
  }, [next]);
  return live;
}

const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

function useScheme(): "light" | "dark" {
  const [dark, setDark] = useState(darkScheme.matches);
  useEffect(() => {
    const onChange = () => setDark(darkScheme.matches);
    darkScheme.addEventListener("change", onChange);
    return () => darkScheme.removeEventListener("change", onChange);
  }, []);
  return dark ? "dark" : "light";
}

/**
 * The design's first page as the preview lays it out, rendered here from its
 * live document rather than a picture of it, so an agent's edits show as they
 * land. It listens without editing or counting as an open canvas, and fades
 * in over the preview once the design arrives.
 */
function LivePreview({ file }: { file: CatalogFile }) {
  const scheme = useScheme();
  const [source, setSource] = useState<SocketSource | null>(null);
  useEffect(() => {
    const s = new SocketSource(`${window.location.origin}${file.base}`, file.key, { watch: true });
    setSource(s);
    return () => s.close();
  }, [file.base, file.key]);
  if (!source) return null;
  return <LiveBoards source={source} scheme={scheme} />;
}

function LiveBoards({ source, scheme }: { source: SocketSource; scheme: "light" | "dark" }) {
  const { doc } = useSource(source);
  const board = useMemo(() => doc && previewArtboard(doc, scheme), [doc, scheme]);
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<number | null>(null);
  const w = board ? Number.parseFloat(board.root.style.width!) : 0;
  const h = board ? Number.parseFloat(board.root.style.height!) : 0;
  useEffect(() => {
    const el = box.current;
    if (!el || !w || !h) return;
    const measure = () => setFit(Math.min(el.clientWidth / w, el.clientHeight / h));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);
  return (
    <div
      ref={box}
      inert
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 grid place-items-center overflow-hidden transition-opacity duration-300",
        board && fit ? "opacity-100" : "opacity-0",
      )}
    >
      {board && (
        <div style={{ width: w * (fit ?? 0), height: h * (fit ?? 0) }}>
          <div
            style={{ width: w, height: h, transform: `scale(${fit ?? 0})`, transformOrigin: "0 0" }}
          >
            <ArtboardView
              artboard={board}
              tokens={doc!.tokens}
              assetBase={source.assetBase}
              colorScheme={scheme}
            />
          </div>
        </div>
      )}
    </div>
  );
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
  cards,
  onOpen,
  onShelve,
  live,
  seen,
}: {
  query: string;
  cards: CatalogCard[];
  onOpen: (target: OpenTarget) => void;
  onShelve?: (card: CatalogCard, action: ShelfAction) => Promise<void>;
  /** Cards to show live (useLive). */
  live: Set<string>;
  seen: Seen;
}) {
  const fileFuse = useMemo(
    () =>
      new Fuse(cards, {
        ...FUSE,
        keys: [
          { name: "file.name", weight: 3 },
          { name: "file.key", weight: 0.5 },
        ],
      }),
    [cards],
  );
  // A design's frames once, from the copy its card opens.
  const frames = useMemo<FrameHit[]>(
    () =>
      cards.flatMap(({ file }) =>
        file.artboards.map((artboard) => ({
          file,
          artboard,
          page: file.pages.find((p) => p.id === artboard.page)?.name,
        })),
      ),
    [cards],
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
                key={item.file.id}
                card={item}
                onOpen={onOpen}
                onShelve={onShelve}
                live={live.has(item.file.id)}
                unseen={isUnseen(seen, item.file)}
                match={ranges(matches, "file.name")}
                pathMatch={ranges(matches, "file.name") ? undefined : ranges(matches, "file.key")}
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
  match,
  pageMatch,
  onOpen,
}: {
  hit: FrameHit;
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
            className="block max-h-[160px] max-w-full object-contain shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_6px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
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
