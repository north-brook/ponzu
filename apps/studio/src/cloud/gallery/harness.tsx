/*
 * Stand-ins for the app around the components: local state where the data layer will be, so
 * every composition can be clicked through.
 */
import { type ReactNode, useCallback, useState } from "react";
import type { ProjectChoice } from "../create/create.ts";
import { CreatePage, type CreatePageProps } from "../create/create-page.tsx";
import { type DesignFilter, NO_FILTER } from "../filter.ts";
import type {
  Contributor,
  DesignSummary,
  Effort,
  Match,
  SearchResults,
  Workspace,
} from "../model.ts";
import { nextAction } from "../pull-request.ts";
import { Sidebar } from "../sidebar/sidebar.tsx";
import { railSignal } from "../status.ts";
import { AppWindow } from "../window/app-window.tsx";
import { DesignChrome, type DesignChromeProps } from "../window/design-chrome.tsx";
import * as f from "./fixtures.ts";

const ignore = () => {};

/** Everything matching `query` in the fixtures, the way the API's search answers. */
function searchFixtures(query: string, designs: DesignSummary[]): SearchResults {
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
  return {
    query,
    designs: hits([...designs, ...f.settled], (d) => d.name).map(({ item, matches }) => ({
      design: item,
      matches,
    })),
    boards: hits(f.heroResults.boards, (b) => b.name).map(({ item, matches }) => ({
      ...item,
      matches,
    })),
    comments: hits(f.heroResults.comments, (c) => c.text).map(({ item, matches }) => ({
      ...item,
      matches,
    })),
  };
}

export interface HarnessProps {
  workspace?: Workspace;
  designs: DesignSummary[] | null;
  openId: string | null;
  initialQuery?: string | null;
  initialSettledOpen?: boolean;
  initialFilter?: DesignFilter;
  settledCount?: number;
  sidebar?: "open" | "closed" | "none";
  /** Past the left block: a design's chrome, or nothing on the create page. */
  chrome?: (sidebarOpen: boolean) => ReactNode;
  rail?: boolean;
  /** What the open rail holds; an empty rail without it. */
  railContent?: ReactNode;
  children: ReactNode;
}

/** The window with a working sidebar around `children`. */
export function Harness({
  workspace = f.northbrook,
  designs,
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
  const results = query?.trim() ? searchFixtures(query, designs ?? []) : null;
  const openDesign = useCallback((d: DesignSummary) => setOpenId(d.id), []);

  return (
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
                  me={f.bryce}
                  workspace={workspace}
                  workspaces={f.workspaces}
                  teammates={f.teammates}
                  designs={designs}
                  settled={{ count: settledCount, designs: f.settled, expanded: settledOpen }}
                  onSettledExpandedChange={setSettledOpen}
                  openDesignId={openId}
                  collapsed={!open}
                  onExpand={() => setOpen(true)}
                  filter={filter}
                  onFilterChange={setFilter}
                  query={query}
                  onQueryChange={setQuery}
                  results={results}
                  onOpenResult={(key) => {
                    if (key.startsWith("design:")) setOpenId(key.slice("design:".length));
                    setQuery(null);
                  }}
                  onOpen={openDesign}
                  onAction={ignore}
                  onRename={ignore}
                  onNewDesign={() => setOpenId(null)}
                  onSwitchWorkspace={ignore}
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
    >
      {children}
    </AppWindow>
  );
}

type ChromeOverrides = Partial<Omit<DesignChromeProps, "sidebarOpen">>;

/** The chrome of an open design, as the boards draw it. */
export function DesignChromeHarness({
  design,
  sidebarOpen,
  contributors,
  railOpen,
  threadUnseen = false,
  changes = true,
  overrides = {},
}: {
  design: DesignSummary;
  sidebarOpen: boolean;
  /** Who has worked on it, in a team workspace; null leaves the presence cluster out. */
  contributors: Contributor[] | null;
  railOpen: boolean;
  threadUnseen?: boolean;
  /** The branch has commits, so a design with no pull request offers Create PR. */
  changes?: boolean;
  overrides?: ChromeOverrides;
}) {
  const [page, setPage] = useState<string | null>(overrides.activePageId ?? f.homePages[0]!.id);
  const [prTab, setPrTab] = useState(false);
  const [rail, setRail] = useState(railOpen);
  const pr = design.pullRequest;
  const action = nextAction(pr, changes);
  return (
    <DesignChrome
      name={design.name}
      sidebarOpen={sidebarOpen}
      pages={f.homePages}
      activePageId={prTab ? null : page}
      onSelectPage={(id) => {
        setPrTab(false);
        setPage(id);
      }}
      onAddPage={ignore}
      team={
        contributors && design.project.kind === "repo"
          ? {
              meId: f.bryce.id,
              contributors,
              repo: design.project.repo,
              members: f.members,
              onOpenRepo: ignore,
            }
          : null
      }
      pullRequest={pr ? { pr, tabOpen: prTab, onToggleTab: () => setPrTab((o) => !o) } : null}
      action={action ? { kind: action, onRun: ignore } : null}
      rail={{
        open: rail,
        signal: railSignal(design, threadUnseen),
        onToggle: () => setRail((o) => !o),
      }}
      {...overrides}
    />
  );
}

/** The create page with its own prompt, model and project. */
export function CreateHarness({
  initialPrompt = "",
  initialProject = { kind: "repo", repo: f.fernwood },
  repos = f.repos,
  ideas = null,
}: {
  initialPrompt?: string;
  initialProject?: ProjectChoice;
  repos?: CreatePageProps["repos"];
  ideas?: CreatePageProps["ideas"];
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [project, setProject] = useState(initialProject);
  const [model, setModel] = useState({ model: f.models[0]!.id, effort: "high" as Effort });
  return (
    <CreatePage
      prompt={prompt}
      onPromptChange={setPrompt}
      onSend={ignore}
      onAttach={ignore}
      model={{
        models: f.models,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        model: model.model,
        effort: model.effort,
        onChange: (m, e) => setModel({ model: m, effort: e }),
      }}
      project={project}
      repos={repos}
      onProjectChange={setProject}
      onAllowMore={ignore}
      ideas={ideas}
    />
  );
}
