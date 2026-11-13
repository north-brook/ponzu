/*
 * Stand-ins for the app around the components: local state where the data layer will be, so
 * every composition can be clicked through.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ProjectChoice, RepoShelf } from "../create/create.ts";
import { CreatePage, type CreatePageProps } from "../create/create-page.tsx";
import { type CanvasFilter, NO_FILTER } from "../filter.ts";
import type {
  CanvasMember,
  CanvasSummary,
  Contributor,
  Effort,
  Match,
  Repo,
  SearchResults,
  Workspace,
} from "../model.ts";
import { nextAction } from "../pull-request.ts";
import { Sidebar } from "../sidebar/sidebar.tsx";
import { railSignal } from "../status.ts";
import { AppWindow } from "../window/app-window.tsx";
import { CanvasChrome, type CanvasChromeProps } from "../window/canvas-chrome.tsx";
import { PANES } from "../window/panes.ts";
import * as f from "./fixtures.ts";

/** `?rail=<px>`: the rail's width, in place of the mockup's. */
const RAIL_WIDTH =
  typeof location === "undefined" ? 0 : Number(new URLSearchParams(location.search).get("rail"));

const ignore = () => {};

/** Everything matching `query` in the fixtures, the way the API's search answers. */
function searchFixtures(query: string, canvases: CanvasSummary[]): SearchResults {
  const q = query.trim().toLowerCase();
  const find = (text: string): Match[] => {
    const at = text.toLowerCase().indexOf(q);
    return at < 0 ? [] : [[at, at + q.length]];
  };
  const hits = <T,>(items: T[], text: (item: T) => string) =>
    items.flatMap((item) => {
      const matches = find(text(item));
      return matches.length ? [{ item, matches }] : [];
    });
  const all = [f.heroResults, f.pricingResults, f.everyResults];
  // The canvases only search finds (not in the sidebar's list), after the list's own.
  const found = all.flatMap((r) => r.canvases.map((hit) => hit.canvas));
  const listed = [...canvases, ...f.settled];
  const named = [...listed, ...found.filter((c) => !listed.some((l) => l.id === c.id))];
  return {
    query,
    canvases: hits(named, (d) => d.name).map(({ item, matches }) => ({
      canvas: item,
      matches,
    })),
    boards: hits(
      all.flatMap((r) => r.boards),
      (b) => b.name,
    ).map(({ item, matches }) => ({ ...item, matches })),
    comments: hits(
      all.flatMap((r) => r.comments),
      (c) => c.snippet,
    ).map(({ item, matches }) => ({ ...item, matches })),
    messages: hits(
      all.flatMap((r) => r.messages),
      (m) => m.snippet,
    ).map(({ item, matches }) => ({ ...item, matches })),
    pullRequests: hits(
      all.flatMap((r) => r.pullRequests),
      (p) => p.title,
    ).map(({ item, matches }) => ({ ...item, matches })),
    people: all
      .flatMap((r) => r.people)
      .flatMap((person) => {
        const nameMatches = find(person.name ?? "");
        const loginMatches = find(person.login);
        return nameMatches.length || loginMatches.length
          ? [{ ...person, nameMatches, loginMatches }]
          : [];
      }),
  };
}

/** The workspace the window shows, and those its switcher lists, for what is inside it. */
const WindowWorkspace = createContext<{
  workspace: Workspace;
  workspaces: Workspace[];
  onSwitch: (workspace: Workspace) => void;
}>({ workspace: f.thistlewick, workspaces: f.workspaces, onSwitch: ignore });

export interface HarnessProps {
  workspace?: Workspace;
  /** Those the workspace switcher lists. */
  workspaces?: Workspace[];
  canvases: CanvasSummary[] | null;
  openId: string | null;
  initialQuery?: string | null;
  initialSettledOpen?: boolean;
  initialFilter?: CanvasFilter;
  settledCount?: number;
  sidebar?: "open" | "closed" | "none";
  /** Past the left block: a canvas's chrome, or nothing on the create page. */
  chrome?: (sidebarOpen: boolean) => ReactNode;
  rail?: boolean;
  /** What the open rail holds; an empty rail without it. */
  railContent?: ReactNode;
  children: ReactNode;
}

/** The window with a working sidebar around `children`. */
export function Harness({
  workspace: initialWorkspace = f.thistlewick,
  workspaces = f.workspaces,
  canvases,
  openId: initialOpen,
  initialQuery = null,
  initialSettledOpen = false,
  initialFilter = NO_FILTER,
  settledCount = f.settled.length,
  sidebar = "open",
  chrome,
  rail = false,
  railContent,
  children,
}: HarnessProps) {
  const [open, setOpen] = useState(sidebar === "open");
  const [openId, setOpenId] = useState(initialOpen);
  const [filter, setFilter] = useState(initialFilter);
  const [query, setQuery] = useState<string | null>(initialQuery);
  const [settledOpen, setSettledOpen] = useState(initialSettledOpen);
  const results = query?.trim() ? searchFixtures(query, canvases ?? []) : null;
  const openCanvas = useCallback((d: CanvasSummary) => setOpenId(d.id), []);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const shown = useMemo(
    () => ({ workspace, workspaces, onSwitch: setWorkspace }),
    [workspace, workspaces],
  );

  return (
    <WindowWorkspace.Provider value={shown}>
      <AppWindow
        lights="drawn"
        sidebar={
          sidebar === "none"
            ? null
            : {
                open,
                onToggle: () => setOpen((o) => !o),
                content: (
                  <Sidebar
                    me={f.ada}
                    workspace={workspace}
                    workspaces={workspaces}
                    teammates={f.teammates}
                    canvases={canvases}
                    settled={{ count: settledCount, canvases: f.settled, expanded: settledOpen }}
                    onSettledExpandedChange={setSettledOpen}
                    openCanvasId={openId}
                    collapsed={!open}
                    onExpand={() => setOpen(true)}
                    filter={filter}
                    onFilterChange={setFilter}
                    query={query}
                    onQueryChange={setQuery}
                    results={results}
                    onOpenResult={(key) => {
                      // What was opened, for the gallery's tests: the app opens it in place.
                      (window as { searchOpened?: string }).searchOpened = key;
                      if (key.startsWith("canvas:")) setOpenId(key.slice("canvas:".length));
                      if (key.startsWith("person:")) {
                        setFilter({ person: key.slice("person:".length), projects: null });
                      }
                      setQuery(null);
                    }}
                    onOpen={openCanvas}
                    onAction={ignore}
                    onRename={ignore}
                    onNewCanvas={() => setOpenId(null)}
                    onSwitchWorkspace={setWorkspace}
                    onAddWorkspace={ignore}
                    onSettings={ignore}
                    onPlan={ignore}
                    onSignOut={ignore}
                  />
                ),
              }
        }
        chrome={chrome?.(open)}
        rail={rail ? (railContent ?? <div />) : null}
        // `?rail=<px>`: the thread rail at that width (its limits in panes.ts), for the tests
        // that look at the thread at its narrowest and widest.
        {...(RAIL_WIDTH ? { panes: { sidebar: PANES.sidebar.default, rail: RAIL_WIDTH } } : {})}
      >
        {children}
      </AppWindow>
    </WindowWorkspace.Provider>
  );
}

type ChromeOverrides = Partial<Omit<CanvasChromeProps, "sidebarOpen">>;

/** The chrome of an open canvas, as the boards draw it. */
export function CanvasChromeHarness({
  canvas,
  sidebarOpen,
  contributors,
  railOpen,
  onToggleRail,
  threadUnseen = false,
  changes = true,
  members = f.members,
  onResetLinks = null,
  overrides = {},
}: {
  canvas: CanvasSummary;
  sidebarOpen: boolean;
  /** Who has worked on it, in a team workspace; null leaves the presence cluster out. */
  contributors: Contributor[] | null;
  /** Who Share lists. */
  members?: CanvasMember[];
  /** Share's "Reset file links", as its owner and the workspace's admins have it; null for others. */
  onResetLinks?: (() => void) | null;
  railOpen: boolean;
  /** The window's rail follows the toggle: without it, only the toggle does. */
  onToggleRail?: () => void;
  threadUnseen?: boolean;
  /** The branch has commits, so a canvas with no pull request offers Create PR. */
  changes?: boolean;
  overrides?: ChromeOverrides;
}) {
  const [page, setPage] = useState<string | null>(overrides.activePageId ?? f.homePages[0]!.id);
  const [prTab, setPrTab] = useState(false);
  const [own, setOwn] = useState(railOpen);
  const rail = onToggleRail ? railOpen : own;
  const pr = canvas.pullRequest;
  const action = nextAction(pr, changes);
  return (
    <CanvasChrome
      name={canvas.name}
      sidebarOpen={sidebarOpen}
      pages={f.homePages}
      activePageId={prTab ? null : page}
      onSelectPage={(id) => {
        setPrTab(false);
        setPage(id);
      }}
      onAddPage={ignore}
      team={
        contributors && canvas.project.kind === "repo"
          ? {
              meId: f.ada.id,
              contributors,
              repo: canvas.project.repo,
              members,
              onOpenRepo: ignore,
              onResetLinks,
            }
          : null
      }
      pullRequest={pr ? { pr, tabOpen: prTab, onToggleTab: () => setPrTab((o) => !o) } : null}
      action={action ? { kind: action, onRun: ignore } : null}
      rail={{
        open: rail,
        signal: railSignal(canvas, threadUnseen),
        onToggle: onToggleRail ?? (() => setOwn((o) => !o)),
      }}
      {...overrides}
    />
  );
}

/**
 * The create page with its own prompt, model and project. With `shelves` (each workspace's
 * repos, null for one whose repos failed to load), the person is in several workspaces: the
 * picker has a group for each, the window's first, and choosing another workspace's Scratch or
 * repo switches the window's workspace (the sidebar's) as the app does, keeping the words.
 * `later` (or `?later`) holds the others' repos back until the page calls
 * `window.galleryArrive()`, as a slow answer would. `?resolve=scratch` or `?resolve=repo` starts
 * the page not knowing its project (the window's repos loading), and `galleryArrive()` settles it
 * on Scratch or on the first repo. `?models=reported` offers what an account's Claude Code
 * reported (a long name, a model that takes no effort) in place of the hand-kept list.
 */
export function CreateHarness({
  initialPrompt = "",
  initialProject = { kind: "repo", repo: f.fernwood },
  repos: ownRepos = f.repos,
  shelves,
  later = false,
  ideas = null,
}: {
  initialPrompt?: string;
  /** Null: not known yet (the window's repos are loading). */
  initialProject?: ProjectChoice | null;
  repos?: CreatePageProps["repos"];
  shelves?: Record<string, Repo[] | null>;
  later?: boolean;
  ideas?: CreatePageProps["ideas"];
}) {
  const params = new URLSearchParams(location.search);
  const resolve = params.get("resolve");
  const offered = params.get("models") === "reported" ? f.reportedModels : f.models;
  const [prompt, setPrompt] = useState(initialPrompt);
  const [project, setProject] = useState(resolve ? null : initialProject);
  const [model, setModel] = useState({ model: offered[0]!.id, effort: "high" as Effort });
  const dwell = Number(params.get("dwell")) || 0;
  const window_ = useContext(WindowWorkspace);
  const [arrived, setArrived] = useState(!later && !params.has("later") && !resolve);
  useEffect(() => {
    (window as { galleryArrive?: () => void }).galleryArrive = () => {
      setArrived(true);
      if (resolve) {
        setProject(
          resolve === "scratch" ? { kind: "scratch" } : { kind: "repo", repo: f.repos[0]! },
        );
      }
    };
  }, [resolve]);
  const repos =
    resolve && !arrived ? null : shelves ? (shelves[window_.workspace.id] ?? []) : ownRepos;
  const elsewhere: RepoShelf[] = shelves
    ? window_.workspaces
        .filter((w) => w.id !== window_.workspace.id && w.id in shelves)
        .map((w) => ({
          workspaceId: w.id,
          name: w.name,
          repos: arrived ? (shelves[w.id] ?? []) : null,
        }))
    : [];
  return (
    <CreatePage
      prompt={prompt}
      onPromptChange={setPrompt}
      onSend={ignore}
      onAttach={ignore}
      model={{
        models: offered,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        model: model.model,
        effort: model.effort,
        onChange: (m, e) => setModel({ model: m, effort: e }),
      }}
      project={project}
      workspaceName={window_.workspace.name}
      repos={repos}
      elsewhere={elsewhere}
      onProjectChange={(choice, workspaceId) => {
        const next = workspaceId && window_.workspaces.find((w) => w.id === workspaceId);
        if (next) window_.onSwitch(next);
        setProject(choice);
      }}
      onAllowMore={ignore}
      ideas={ideas}
      // `?dwell=<ms>`: how long each suggestion shows, so a test needn't wait out the real one.
      {...(dwell ? { suggestionDwellMs: dwell } : {})}
    />
  );
}
