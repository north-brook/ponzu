import { PencilEdit02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { type ReactNode, useRef } from "react";
import { applyFilter, type DesignFilter, isFiltering, NO_FILTER, repoCounts } from "../filter.ts";
import type { DesignSummary, Person, SearchResults, Workspace } from "../model.ts";
import type { ResultKey } from "../search.ts";
import { orderDesigns } from "../status.ts";
import { Button, IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { useShortcut } from "../ui/shortcut.ts";
import { DesignList, DesignListSkeleton, type RowHandlers } from "./design-list.tsx";
import { FilterMenu } from "./filter-menu.tsx";
import { SearchField, SearchResultsView, useResultSelection } from "./search.tsx";
import { SettledTray } from "./settled-tray.tsx";
import { WorkspaceMenu } from "./workspace-menu.tsx";

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
 * query its results take the list's.
 */
export function Sidebar(props: SidebarProps) {
  const { me, workspace, designs, filter, query, results } = props;
  const searchButton = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useResultSelection(results);

  useShortcut("k", () => props.onQueryChange(query ?? ""));
  useShortcut("n", props.onNewDesign);

  const closeSearch = () => {
    props.onQueryChange(null);
    // Back to where search was opened from.
    requestAnimationFrame(() => searchButton.current?.focus());
  };

  const searching = query !== null && query.trim() !== "";
  const team = workspace.kind === "org";
  const shown = designs ? orderDesigns(applyFilter(designs, filter), workspace.kind) : null;
  const handlers: RowHandlers = {
    onOpen: props.onOpen,
    onAction: props.onAction,
    onRename: props.onRename,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
            ref={searchButton}
            label="Search"
            keys={["⌘", "K"]}
            onClick={() => props.onQueryChange("")}
            className="h-[26px] w-6"
          >
            <Icon icon={Search01Icon} size={15} stroke={1.7} />
          </IconButton>
          <FilterMenu
            filter={filter}
            onChange={props.onFilterChange}
            me={me}
            teammates={team ? props.teammates : null}
            repos={repoCounts(designs ?? [])}
          />
          <IconButton
            label="New design"
            keys={["⌘", "N"]}
            onClick={props.onNewDesign}
            className="h-[26px] w-6 text-icon-strong"
          >
            <Icon icon={PencilEdit02Icon} size={15} stroke={1.7} />
          </IconButton>
        </div>
      ) : (
        <SearchField
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
          <ScrollArea className="flex-1">
            {shown === null ? (
              <DesignListSkeleton />
            ) : shown.length ? (
              <DesignList
                designs={shown}
                openId={props.openDesignId}
                label="Designs"
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
              <EmptyNote>No designs yet.</EmptyNote>
            )}
          </ScrollArea>
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

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 px-2.5 pt-1.5 text-13 text-muted">
      {children}
    </div>
  );
}
