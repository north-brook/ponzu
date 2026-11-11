import { PencilEdit02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { type ReactNode, useMemo, useRef } from "react";
import {
  applyFilter,
  type DesignFilter,
  isFiltering,
  NO_FILTER,
  projectCounts,
} from "../filter.ts";
import type { DesignSummary, Person, SearchResults, Workspace } from "../model.ts";
import type { ResultKey } from "../search.ts";
import { orderDesigns, settledShown } from "../status.ts";
import { Button, IconButton } from "../ui/button.tsx";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { jumpTarget, useJumpShortcuts, useShortcut } from "../ui/shortcut.ts";
import { DesignList, DesignListSkeleton } from "./design-list.tsx";
import type { RowHandlers } from "./design-row.tsx";
import { FilterMenu } from "./filter-menu.tsx";
import { useRowMotion } from "./row-motion.ts";
import { SearchField, SearchResultsView, useResultSelection } from "./search.tsx";
import { SettledTray } from "./settled-tray.tsx";
import { WorkspaceMenu } from "./workspace-menu.tsx";

/** The row handlers are passed to every row: keep them the same functions between renders. */
export interface SidebarProps extends RowHandlers {
  me: Person;
  workspace: Workspace;
  workspaces: Workspace[];
  /** Everyone else in the workspace, for the filter. */
  teammates: Person[];
  /** The workspace's active designs; null while they load. */
  designs: DesignSummary[] | null;
  settled: { count: number; designs: DesignSummary[] | null; expanded: boolean };
  onSettledExpandedChange: (expanded: boolean) => void;
  openDesignId: string | null;
  /** The window's sidebar is collapsed; ⌘K expands it before it searches. */
  collapsed: boolean;
  onExpand: () => void;
  filter: DesignFilter;
  onFilterChange: (filter: DesignFilter) => void;
  /** Null while search is closed; "" open and empty. */
  query: string | null;
  onQueryChange: (query: string | null) => void;
  /** The answer for `query`, or null while it is on its way. */
  results: SearchResults | null;
  onOpenResult: (key: ResultKey) => void;
  onNewDesign: () => void;
  onSwitchWorkspace: (workspace: Workspace) => void;
  onAddWorkspace: () => void;
  onSettings: () => void;
  onPlan: () => void;
  onSignOut: () => void;
}

/**
 * The sidebar: the workspace switcher and Search, Filter and New design over the workspace's
 * designs by recency, the settled tray at the foot. Search takes the header row's place; with a
 * query its results take the list's. It holds the shortcuts for what it offers: ⌘K, ⌘N, ⌘, and
 * the numbers: ⌘1–9 open the designs in the order the list shows them (filtered; 9 the last;
 * settled ones aren't counted) and ⌘0 the create page. They work with the sidebar collapsed,
 * with no numbers to show; while search's results take the list's place ⌘1–9 rest, so a number
 * never opens a design you can't see.
 */
export function Sidebar(props: SidebarProps) {
  const { me, workspace, designs, filter, query, results } = props;
  const searchField = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useResultSelection(results);

  useShortcut("k", () => {
    if (props.collapsed) props.onExpand();
    if (query === null) props.onQueryChange("");
    // Already open: back into the field, once the pane is no longer inert. A field just opened
    // takes focus as it mounts.
    else requestAnimationFrame(() => searchField.current?.focus({ preventScroll: true }));
  });
  useShortcut("n", props.onNewDesign);
  useShortcut(",", props.onSettings);

  // Closing search leaves focus nowhere in particular: putting it back on the search button
  // would show that button's tip, as if the person had gone to it.
  const closeSearch = () => props.onQueryChange(null);

  const searching = query !== null && query.trim() !== "";
  const team = workspace.kind === "org";
  const shown = useMemo(
    () => (designs ? orderDesigns(applyFilter(designs, filter), workspace.kind) : null),
    [designs, filter, workspace.kind],
  );
  const projects = useMemo(() => projectCounts(designs ?? []), [designs]);
  const hint = useJumpShortcuts("design", (n) => {
    if (n === 0) {
      props.onNewDesign();
      return true;
    }
    if (searching) return false;
    const design = jumpTarget(shown ?? [], n);
    if (design && design.id !== props.openDesignId) props.onOpen(design);
    return design !== undefined;
  });
  // Which rows show, and in what order: when this changes, what moved slides (row-motion.ts).
  const lists = useRef<HTMLDivElement>(null);
  const settledRows = settledShown(
    props.settled.designs ?? [],
    props.settled.expanded,
    props.openDesignId,
  );
  useRowMotion(
    lists,
    [
      ...(shown ?? []).map((design) => design.id),
      "|",
      ...settledRows.map((design) => design.id),
    ].join(" "),
  );
  const handlers: RowHandlers = {
    onOpen: props.onOpen,
    onAction: props.onAction,
    onRename: props.onRename,
  };

  return (
    <div ref={lists} className="flex min-h-0 flex-1 flex-col">
      {query === null ? (
        <div className="flex h-[34px] shrink-0 items-center rounded-9 pl-2.5">
          <WorkspaceMenu
            current={workspace}
            workspaces={props.workspaces}
            onSwitch={props.onSwitchWorkspace}
            onAddWorkspace={props.onAddWorkspace}
            onSettings={props.onSettings}
            onPlan={props.onPlan}
            onSignOut={props.onSignOut}
          />
          <span className="flex-1" />
          <IconButton
            label="Search"
            keys={["⌘", "K"]}
            onClick={() => props.onQueryChange("")}
            className="h-[26px] w-6"
          >
            <Icon icon={Search01Icon} step="control" />
          </IconButton>
          <FilterMenu
            filter={filter}
            onChange={props.onFilterChange}
            me={me}
            teammates={team ? props.teammates : null}
            projects={projects}
          />
          <IconButton
            label="New design"
            keys={["⌘", "N"]}
            onClick={props.onNewDesign}
            className="h-[26px] w-6"
          >
            <Icon icon={PencilEdit02Icon} step="control" />
          </IconButton>
        </div>
      ) : (
        <SearchField
          fieldRef={searchField}
          query={query}
          onQueryChange={props.onQueryChange}
          results={searching ? results : null}
          selected={selected}
          onSelect={setSelected}
          onOpenResult={props.onOpenResult}
          onClose={closeSearch}
        />
      )}
      <div className="h-2 shrink-0" />
      {searching ? (
        <SearchResultsView
          query={query}
          results={results}
          selected={selected}
          onSelect={setSelected}
          onOpenResult={props.onOpenResult}
        />
      ) : (
        <>
          <FadeScroll className="flex-1">
            {shown === null ? (
              <DesignListSkeleton />
            ) : shown.length ? (
              <DesignList
                designs={shown}
                openId={props.openDesignId}
                label="Designs"
                shortcuts
                hint={hint && !props.collapsed}
                {...handlers}
              />
            ) : isFiltering(filter) ? (
              <EmptyNote>
                No designs match this filter.
                <Button
                  variant="quiet"
                  className="-ml-2 px-2"
                  onClick={() => props.onFilterChange(NO_FILTER)}
                >
                  Clear filter
                </Button>
              </EmptyNote>
            ) : (
              <EmptyTrace
                label={props.settled.count ? "No designs in progress" : "No designs yet"}
              />
            )}
          </FadeScroll>
          {props.settled.count ? (
            <SettledTray
              count={props.settled.count}
              designs={props.settled.designs}
              expanded={props.settled.expanded}
              onExpandedChange={props.onSettledExpandedChange}
              openId={props.openDesignId}
              {...handlers}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * An empty list: the faint trace of rows that aren't there yet, fading out, and no words to
 * read. What it means is said once, for a screen reader.
 */
function EmptyTrace({ label }: { label: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="flex flex-col gap-px opacity-70 [mask-image:linear-gradient(to_bottom,black,transparent)]"
    >
      {[58, 44, 66].map((name) => (
        <div key={name} className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="h-12 w-16 shrink-0 rounded-4 border border-sep border-dashed" />
          <span className="flex flex-1 flex-col gap-[9px]">
            <span className="h-px w-1/4 bg-sep" />
            <span className="h-px bg-sep" style={{ width: `${name}%` }} />
            <span className="h-px w-2/5 bg-sep" />
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 px-2.5 pt-1.5 text-13 text-muted">
      {children}
    </div>
  );
}
