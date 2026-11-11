import { Canvas } from "@ponzu/canvas";
import { DocCache, presentNow } from "@ponzu/client";
import { CloudSource, type Unsaved } from "@ponzu/client/canvas";
import { useLiveQuery } from "@ponzu/client/react";
import { type Actor, newId } from "@ponzu/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DesignMember, DesignSummary, Person, WorkspaceKind } from "../cloud/model.ts";
import { railSignal } from "../cloud/status.ts";
import { useNow } from "../cloud/time.ts";
import { useColorScheme } from "../cloud/ui/color-scheme.ts";
import { DesignChrome } from "../cloud/window/design-chrome.tsx";
import type { Host } from "./host.ts";
import { contributors, pageTabs } from "./map.ts";
import { Banner, PaneMessage } from "./notices.tsx";

/*
 * An open design: the canvas on a `CloudSource`, and the chrome over it, both driven by the
 * same source and the design's live head. The source lives as long as the design is open.
 */

export interface OpenDesign {
  id: string;
  source: CloudSource;
}

/** The open design's source, made when `designId` changes and closed when it does again. */
export function useCloudSource(host: Host, me: Person, designId: string | null): OpenDesign | null {
  const [open, setOpen] = useState<OpenDesign | null>(null);
  const actor = useMemo<Actor>(
    () => ({
      kind: "user",
      id: me.id,
      name: me.name,
      ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}),
    }),
    [me],
  );
  const cache = useMemo(
    () => (host.docStorage ? new DocCache(host.docStorage, 4) : undefined),
    [host],
  );
  useEffect(() => {
    if (!designId) {
      setOpen(null);
      return;
    }
    const source = new CloudSource({
      api: host.api,
      live: host.live,
      designId,
      me: actor,
      ...(cache ? { cache } : {}),
    });
    setOpen({ id: designId, source });
    return () => source.close();
  }, [host, actor, cache, designId]);
  return open && open.id === designId ? open : null;
}

export function useSourceState(source: CloudSource) {
  return useSyncExternalStore(
    (changed) => source.subscribe(changed),
    () => source.getState(),
  );
}

/** The chrome past the left block for an open design. */
export function DesignChromeSlot({
  open,
  summary,
  me,
  workspaceKind,
  members,
  sidebarOpen,
  page,
  onPage,
  rail,
  onOpenRepo,
}: {
  open: OpenDesign;
  /** Its sidebar row, once the list has it. */
  summary: DesignSummary | null;
  me: Person;
  workspaceKind: WorkspaceKind;
  members: DesignMember[];
  sidebarOpen: boolean;
  page: string | null;
  onPage: (id: string) => void;
  rail: { open: boolean; onToggle: () => void };
  onOpenRepo: (fullName: string) => void;
}) {
  const state = useSourceState(open.source);
  const head = useLiveQuery("design.head", { designId: open.id }).rows?.[0];
  const presence = useLiveQuery("design.presence", { designId: open.id }).rows ?? [];
  const now = useNow();
  const doc = state.doc;
  const pages = doc ? pageTabs(doc.pages, head?.agentArtboards ?? []) : [];
  const project = summary?.project ?? null;
  const pr = summary?.pullRequest ?? null;
  return (
    <DesignChrome
      name={head?.name ?? summary?.name ?? doc?.name ?? ""}
      sidebarOpen={sidebarOpen}
      pages={pages}
      activePageId={page ?? pages[0]?.id ?? null}
      onSelectPage={onPage}
      onAddPage={() => {
        if (!doc || !open.source.writable) return;
        const id = newId("pg");
        open.source.apply({
          op: "page.create",
          index: doc.pages.length,
          page: { id, name: `Page ${doc.pages.length + 1}` },
        });
        onPage(id);
      }}
      team={
        workspaceKind === "org" && project?.kind === "repo"
          ? {
              meId: me.id,
              contributors: contributors(presentNow(presence, now), me),
              repo: project.repo,
              members,
              onOpenRepo: () => onOpenRepo(`${project.repo.owner}/${project.repo.name}`),
            }
          : null
      }
      // SEAM(pull request tab): the tab and the next action arrive with the PR track; until
      // then the mark shows the pull request's state and the dark button offers nothing.
      pullRequest={pr ? { pr, tabOpen: false, onToggleTab: () => {} } : null}
      action={null}
      rail={{
        open: rail.open,
        signal: summary ? railSignal(summary, false) : "idle",
        onToggle: rail.onToggle,
      }}
    />
  );
}

/** The canvas pane for an open design, with what can go wrong said over it. */
export function DesignCanvas({
  host,
  open,
  me,
  page,
  onPage,
  link,
  onClose,
}: {
  host: Host;
  open: OpenDesign;
  me: Person;
  page: string | null;
  onPage: (id: string) => void;
  /** Where a link asked to open it. */
  link?: { page?: string; artboard?: string };
  /** Leave it: back to the create page. */
  onClose: () => void;
}) {
  const { source, id } = open;
  const state = useSourceState(source);
  const theme = useColorScheme();
  const head = useLiveQuery("design.head", { designId: id });
  const seq = head.rows?.[0]?.seq;
  // A design you can open always has its head row: none, live, is one deleted or taken away.
  const gone = state.status === "error" || (head.status === "live" && head.rows?.length === 0);
  const unsaved = useUnsaved(source);

  // The person has seen it as it stands: the sidebar's dot goes.
  useEffect(() => {
    if (seq === undefined || state.status !== "ready") return;
    const timer = setTimeout(() => void host.api.designs.seen(id).catch(() => {}), 1000);
    return () => clearTimeout(timer);
  }, [host, id, seq, state.status]);

  // The page each tab shows is the chrome's; the others hear it through presence.
  useEffect(() => {
    source.setPage(page);
  }, [source, page]);

  // The network is back: don't wait out the retry.
  useEffect(() => {
    const online = () => source.retryNow();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [source]);

  if (gone) {
    return (
      <PaneMessage
        title="This design isn't here any more"
        body="It was deleted, or you no longer have access to its repo on GitHub."
        action={{ label: "Back to designs", onClick: onClose }}
      />
    );
  }
  if (!state.doc) {
    return state.status === "offline" ? (
      <PaneMessage
        title="Can't reach Ponzu"
        body="This design opens as soon as you're back online."
        busy
      />
    ) : null;
  }
  return (
    <>
      <Canvas
        source={source}
        me={{
          kind: "user",
          id: me.id,
          name: me.name,
          ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}),
        }}
        theme={theme}
        readOnly={!source.writable}
        pageBar={false}
        {...(page ? { page } : {})}
        onPageChange={onPage}
        {...(link ? { link } : {})}
      />
      {state.status === "offline" ? (
        <Banner>You're offline. Your changes are kept here and sent when you're back.</Banner>
      ) : unsaved ? (
        <Banner>{unsaved.reason}</Banner>
      ) : null}
    </>
  );
}

/** The last edit that didn't make it, shown for a few seconds. */
function useUnsaved(source: CloudSource): Unsaved | null {
  const [unsaved, setUnsaved] = useState<Unsaved | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () =>
      source.onUnsaved((next) => {
        setUnsaved(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setUnsaved(null), 6000);
      }),
    [source],
  );
  return unsaved;
}
