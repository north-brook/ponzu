import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { DesignMember, DesignSummary, Person, WorkspaceKind } from "../cloud/model.ts";
import { DesignCanvas, DesignChromeSlot, type OpenDesign } from "./design.tsx";
import type { Host } from "./host.ts";
import { BypassConfirmation, PullRequestPane } from "./pull-request-pane.tsx";
import { DesignRail } from "./thread-rail.tsx";

/*
 * What the window shows for an open design, in AppWindow's three slots: the chrome, the thread
 * rail, and the canvas's pane, which the pull request tab takes over while it is open (the rail
 * folds away meanwhile, and comes back as it was). A board a line of the thread points at is
 * shown on the canvas.
 */

export interface DesignPanes {
  chrome: ReactNode;
  rail: ReactNode | null;
  pane: ReactNode;
}

export function useDesignPanes({
  host,
  me,
  open,
  summary,
  people,
  members,
  workspaceKind,
  sidebarOpen,
  rail,
  page,
  onPage,
  link,
  seenThreadSeq,
  say,
  onClose,
  onConnectClaude,
}: {
  host: Host;
  me: Person;
  open: OpenDesign | null;
  /** Its row in the sidebar, once the list has it. */
  summary: DesignSummary | null;
  /** The workspace's members by id. */
  people: ReadonlyMap<string, Person>;
  members: DesignMember[];
  workspaceKind: WorkspaceKind;
  sidebarOpen: boolean;
  rail: { open: boolean; onToggle: () => void };
  page: string | null;
  onPage: (id: string) => void;
  /** Where a ponzu:// link asked to open it. */
  link: { page?: string; artboard?: string } | null;
  seenThreadSeq: number | null;
  say: (notice: string) => void;
  /** Leave it: back to the create page. */
  onClose: () => void;
  onConnectClaude?: () => void;
}): DesignPanes | null {
  const [prTab, setPrTab] = useState(false);
  const [shown, setShown] = useState<{ artboard: string; at: number } | null>(null);
  const designId = open?.id ?? null;
  // Another design opens on its canvas, where its own link or the person left it.
  useEffect(() => {
    if (designId !== null) {
      setPrTab(false);
      setShown(null);
    }
  }, [designId]);

  const onOpenArtboards = useCallback((ids: string[]) => {
    const [artboard] = ids;
    if (!artboard) return;
    setPrTab(false);
    setShown({ artboard, at: Date.now() });
  }, []);

  if (!open) return null;
  const project = summary?.project ?? null;
  const repo = project?.kind === "repo" ? project.repo : null;
  const owner = summary?.owner ?? null;
  const togglePrTab = () => setPrTab((was) => !was);

  return {
    chrome: (
      <DesignChromeSlot
        open={open}
        summary={summary}
        me={me}
        owner={owner}
        workspaceKind={workspaceKind}
        members={members}
        sidebarOpen={sidebarOpen}
        page={page}
        onPage={onPage}
        rail={rail}
        prTab={{ open: prTab, onToggle: togglePrTab }}
        seenThreadSeq={seenThreadSeq}
        onOpenRepo={(fullName) => host.openExternal(`https://github.com/${fullName}`)}
      />
    ),
    rail:
      rail.open && !prTab ? (
        <DesignRail
          host={host}
          open={open}
          me={me}
          people={people}
          repo={repo}
          owner={owner}
          onOpenArtboards={onOpenArtboards}
          onOpenPullRequest={() => setPrTab(true)}
          say={say}
          {...(onConnectClaude ? { onConnectClaude } : {})}
        />
      ) : null,
    pane: (
      <>
        <div inert={prTab} className="contents">
          <DesignCanvas
            key={open.id}
            host={host}
            open={open}
            me={me}
            page={page}
            onPage={onPage}
            {...(shown ? { link: shown } : link ? { link } : {})}
            onClose={onClose}
          />
        </div>
        {prTab ? (
          <div className="absolute inset-0 bg-canvas">
            <PullRequestPane host={host} open={open} viewerLogin={me.login} />
          </div>
        ) : null}
        <BypassConfirmation open={open} />
      </>
    ),
  };
}
