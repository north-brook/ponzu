import type { Api, Profile } from "@ponzu/client";
import { useLiveQuery } from "@ponzu/client/react";
import type { DeepLink } from "@ponzu/desktop/bridge";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { DesignSummary, Person } from "../cloud/model.ts";
import type { ResultKey } from "../cloud/search.ts";
import type { RowAction } from "../cloud/sidebar/design-row.tsx";
import { Sidebar } from "../cloud/sidebar/sidebar.tsx";
import { orderSettled } from "../cloud/status.ts";
import { AppWindow } from "../cloud/window/app-window.tsx";
import { CreateView } from "./create.tsx";
import { DesignCanvas, DesignChromeSlot, useCloudSource } from "./design.tsx";
import type { Host } from "./host.ts";
import {
  designMembers,
  membersById,
  pushableRepos,
  searchByName,
  toPerson,
  toSummary,
  toWorkspace,
  usableWorkspaces,
} from "./map.ts";
import { Banner, PaneMessage } from "./notices.tsx";
import { ThreadRail } from "./thread-rail.tsx";
import { filterFor, loadUi, saveUi, type UiState } from "./ui-state.ts";
import { useAnswer, useOnReturn } from "./use-answer.ts";

/*
 * The main window, signed in: the person's workspaces from `me`, one of them open with its
 * designs live in the sidebar, and in the canvas pane either a design or the create page.
 * Routing is this state and links; what the window was showing is remembered per person.
 */

type MeWorkspace = Awaited<ReturnType<Api["me"]>>["workspaces"][number];

/** Where a link asked to open a design. */
interface Opening {
  designId: string;
  page?: string;
  artboard?: string;
}

const RETURN_SYNC_MS = 60_000;
const NOTICE_MS = 6000;

export function MainWindow({ host, user, badge }: { host: Host; user: Profile; badge: ReactNode }) {
  const me = useMemo(() => toPerson(user.id, user), [user]);
  const [ui, setUi] = useState(() => loadUi(user.id));
  const update = useCallback(
    (change: (ui: UiState) => UiState) =>
      setUi((now) => {
        const next = change(now);
        saveUi(user.id, next);
        return next;
      }),
    [user.id],
  );
  const meAnswer = useAnswer(() => host.api.me(), user.id);
  const reloadMe = meAnswer.reload;
  const [opening, setOpening] = useState<Opening | null>(null);
  const [notice, say] = useNotice();

  // Signed in without a keychain to keep the session in: say so once, now, when it matters.
  useEffect(() => {
    void host.persistence().then((persistence) => {
      if (persistence === "memory") {
        say("Ponzu can't use this computer's keychain, so you'll sign in again next time.");
      } else if (persistence === "file") {
        say("Signed in with a developer's session file, kept unencrypted, not in the keychain.");
      }
    });
  }, [host, say]);

  // Back in front: GitHub may have changed who reaches what (docs/cloud.md, "Keeping it true").
  const sync = useCallback(async () => {
    await host.api.github.sync().catch(() => {});
    reloadMe();
  }, [host, reloadMe]);
  useOnReturn(sync, RETURN_SYNC_MS);
  useEffect(() => {
    window.addEventListener("online", reloadMe);
    return () => window.removeEventListener("online", reloadMe);
  }, [reloadMe]);
  // Live queries rest while the window is out of sight, and come back whole.
  useEffect(() => {
    const change = () =>
      document.visibilityState === "hidden" ? host.live.pause() : host.live.resume();
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, [host]);

  useEffect(
    () =>
      host.onLink((link: DeepLink) => {
        if (link.kind === "github_setup") {
          void sync();
          if (link.workspaceId) {
            const workspaceId = link.workspaceId;
            update((now) => ({ ...now, workspaceId }));
          }
          if (link.result === "requested") {
            say("Ponzu asked the organization's owners to install it. It shows here once they do.");
          } else if (link.result === "failed") {
            say("GitHub didn't finish setting Ponzu up. Try again.");
          }
          return;
        }
        host.api.designs.get(link.designId).then(
          (design) => {
            update((now) => ({
              ...now,
              workspaceId: design.workspaceId,
              designs: { ...now.designs, [design.workspaceId]: design.id },
            }));
            setOpening({
              designId: design.id,
              ...(link.pageId ? { page: link.pageId } : {}),
              ...(link.artboardId ? { artboard: link.artboardId } : {}),
            });
          },
          () => say("That design isn't there, or you can't open it."),
        );
      }),
    [host, sync, update, say],
  );

  const all = meAnswer.data?.workspaces ?? null;
  const usable = useMemo(() => (all ? usableWorkspaces(all) : []), [all]);
  const workspace = usable.find((w) => w.id === ui.workspaceId) ?? usable[0] ?? null;

  if (!all || !workspace) {
    return (
      <AppWindow lights={host.lights} sidebar={null} rail={null} badge={badge}>
        {!all ? (
          meAnswer.error ? (
            <PaneMessage
              title="Can't reach Ponzu"
              body="Check your connection. Your designs are safe in the cloud and open as soon as Ponzu is back."
              action={{ label: "Try again", onClick: reloadMe }}
              busy
            />
          ) : null
        ) : (
          <NoWorkspace host={host} />
        )}
        {notice ? <Banner>{notice}</Banner> : null}
      </AppWindow>
    );
  }
  return (
    <WorkspaceWindow
      key={workspace.id}
      host={host}
      me={me}
      workspace={workspace}
      workspaces={usable}
      ui={ui}
      update={update}
      badge={badge}
      opening={opening}
      notice={notice}
      say={say}
      onLostAccess={() => {
        update((now) => ({ ...now, workspaceId: null }));
        void sync();
      }}
    />
  );
}

/** The window for one workspace. Keyed by it: switching starts its state over. */
function WorkspaceWindow({
  host,
  me,
  workspace,
  workspaces,
  ui,
  update,
  badge,
  opening,
  notice,
  say,
  onLostAccess,
}: {
  host: Host;
  me: Person;
  workspace: MeWorkspace;
  workspaces: MeWorkspace[];
  ui: UiState;
  update: (change: (ui: UiState) => UiState) => void;
  badge: ReactNode;
  opening: Opening | null;
  notice: string | null;
  say: (notice: string) => void;
  onLostAccess: () => void;
}) {
  const id = workspace.id;
  const detail = useAnswer(() => host.api.workspaces.get(id), id);
  useOnReturn(detail.reload, RETURN_SYNC_MS);
  const people = useMemo(() => membersById(detail.data?.members ?? []), [detail.data]);
  const repos = useMemo(
    () => (detail.data ? pushableRepos(detail.data.repos) : null),
    [detail.data],
  );
  const live = useLiveQuery("workspace.designs", { workspaceId: id });
  const openId = ui.designs[id] ?? null;
  const open = useCloudSource(host, me, openId);
  const [page, setPage] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [settledOpen, setSettledOpen] = useState(false);

  const summaries = useMemo(
    () => live.rows?.map((row) => toSummary(row, { people, open: row.id === openId })) ?? null,
    [live.rows, people, openId],
  );
  const active = useMemo(
    () => summaries?.filter((d) => d.status === "active") ?? null,
    [summaries],
  );
  const settled = useMemo(
    () => (summaries ? orderSettled(summaries.filter((d) => d.status === "settled")) : null),
    [summaries],
  );
  const openSummary = summaries?.find((d) => d.id === openId) ?? null;
  const link = opening && opening.designId === openId ? opening : null;

  const openDesign = useCallback(
    (designId: string | null) => {
      update((now) => {
        const { [id]: _was, ...others } = now.designs;
        return { ...now, designs: designId ? { ...others, [id]: designId } : others };
      });
      setPage(null);
    },
    [id, update],
  );
  useEffect(() => {
    if (link?.page) setPage(link.page);
  }, [link]);

  useEffect(
    () =>
      host.onCommand((command) => {
        if (command === "new-design") openDesign(null);
        // SEAM(settings): the settings track mounts Settings here.
      }),
    [host, openDesign],
  );

  const addWorkspace = useCallback(() => {
    host.api.github.installLink({ client: "mac" }).then(
      ({ url }) => host.openExternal(url),
      () => say("GitHub's install page couldn't be opened. Try again."),
    );
  }, [host, say]);

  const onOpen = useCallback((design: DesignSummary) => openDesign(design.id), [openDesign]);
  const onAction = useCallback(
    (design: DesignSummary, action: Exclude<RowAction, "rename">) => {
      const failed = () => say(`“${design.name}” couldn't be changed. Try again.`);
      if (action === "copy_link") {
        void navigator.clipboard.writeText(`ponzu://design/${design.id}`).catch(failed);
      } else if (action === "settle" || action === "reopen") {
        host.api.designs.settle(design.id, action === "settle").catch(failed);
      } else if (action === "delete") {
        if (!window.confirm(`Delete “${design.name}”? Its canvas and thread go for everyone.`)) {
          return;
        }
        host.api.designs.delete(design.id).then(() => {
          if (design.id === openId) openDesign(null);
        }, failed);
      }
    },
    [host, openId, openDesign, say],
  );
  const onRename = useCallback(
    (design: DesignSummary, name: string) => {
      host.api.designs
        .rename(design.id, { name })
        .catch(() => say(`“${design.name}” couldn't be renamed. Try again.`));
    },
    [host, say],
  );

  const lost =
    live.status === "ended" &&
    (live.error?.code === "not_found" || live.error?.code === "forbidden");
  // A brand-new personal workspace has no sidebar until its first design (onboarding 3.6).
  const firstDesign = workspace.kind === "personal" && summaries?.length === 0;
  const designs = [...(active ?? []), ...(settled ?? [])];
  const sidebarOpen = ui.sidebarOpen;

  return (
    <AppWindow
      lights={host.lights}
      badge={badge}
      sidebar={
        firstDesign
          ? null
          : {
              open: sidebarOpen,
              onToggle: () => update((now) => ({ ...now, sidebarOpen: !now.sidebarOpen })),
              content: (
                <Sidebar
                  me={me}
                  workspace={toWorkspace(workspace)}
                  workspaces={workspaces.map(toWorkspace)}
                  teammates={[...people.values()].filter((person) => person.id !== me.id)}
                  designs={active}
                  settled={{
                    count: settled?.length ?? 0,
                    designs: settled,
                    expanded: settledOpen,
                  }}
                  onSettledExpandedChange={setSettledOpen}
                  openDesignId={openId}
                  collapsed={!sidebarOpen}
                  onExpand={() => update((now) => ({ ...now, sidebarOpen: true }))}
                  filter={filterFor(ui, id)}
                  onFilterChange={(filter) =>
                    update((now) => ({ ...now, filters: { ...now.filters, [id]: filter } }))
                  }
                  query={query}
                  onQueryChange={setQuery}
                  results={query?.trim() ? searchByName(query, designs) : null}
                  onOpenResult={(key: ResultKey) => {
                    if (key.startsWith("design:")) openDesign(key.slice("design:".length));
                    setQuery(null);
                  }}
                  onOpen={onOpen}
                  onAction={onAction}
                  onRename={onRename}
                  onNewDesign={() => openDesign(null)}
                  onSwitchWorkspace={(next) => update((now) => ({ ...now, workspaceId: next.id }))}
                  onAddWorkspace={addWorkspace}
                  // SEAM(settings): Settings and Plan and usage arrive with the settings track.
                  onSettings={() => {}}
                  onPlan={() => {}}
                  onSignOut={() => void host.session.signOut()}
                />
              ),
            }
      }
      chrome={
        open && !lost ? (
          <DesignChromeSlot
            open={open}
            summary={openSummary}
            me={me}
            workspaceKind={workspace.kind}
            members={designMembers(detail.data?.members ?? [], openSummary?.owner?.id ?? null)}
            sidebarOpen={!firstDesign && sidebarOpen}
            page={page}
            onPage={setPage}
            rail={{
              open: ui.railOpen,
              onToggle: () => update((now) => ({ ...now, railOpen: !now.railOpen })),
            }}
            onOpenRepo={(fullName) => host.openExternal(`https://github.com/${fullName}`)}
          />
        ) : undefined
      }
      rail={open && !lost && ui.railOpen ? <ThreadRail host={host} open={open} /> : null}
    >
      {lost ? (
        <PaneMessage
          title={`You're no longer in ${toWorkspace(workspace).name}`}
          body="GitHub says you can't reach it any more. Ask one of its owners if that's a mistake."
          action={{ label: "Go to another workspace", onClick: onLostAccess }}
        />
      ) : open ? (
        <DesignCanvas
          key={open.id}
          host={host}
          open={open}
          me={me}
          page={page}
          onPage={setPage}
          {...(link ? { link } : {})}
          onClose={() => openDesign(null)}
        />
      ) : openId ? null : (
        <CreateView
          host={host}
          workspaceId={id}
          repos={repos}
          onAllowMore={addWorkspace}
          onCreated={(designId, messageFailed) => {
            openDesign(designId);
            if (messageFailed) {
              say("The design is made, but your message didn't reach Claude. Send it again.");
            }
          }}
        />
      )}
      {notice ? <Banner>{notice}</Banner> : null}
    </AppWindow>
  );
}

/**
 * Signed in, but nowhere to design: the Ponzu GitHub App is on none of the person's accounts.
 *
 * SEAM(guided setup): the setup track's "Where do you design?" replaces this. Until then this is
 * its least: install the App on GitHub, and the workspace appears when the browser comes back.
 */
function NoWorkspace({ host }: { host: Host }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="absolute inset-0 flex flex-col items-center pt-[200px] text-center">
      <h1 className="m-0 font-display font-semibold text-[28px] tracking-[-0.02em]">
        Where do you design?
      </h1>
      <p className="m-0 mt-3 max-w-[460px] text-[15px] text-muted leading-[1.55]">
        Ponzu works in the GitHub accounts it's installed on. Set it up on yours or an
        organization's, and choose the repos it can open.
      </p>
      <button
        type="button"
        onClick={() =>
          host.api.github.installLink({ client: "mac" }).then(
            ({ url }) => host.openExternal(url),
            () => setFailed(true),
          )
        }
        className="app-no-drag mt-8 flex h-9 cursor-default items-center gap-1.5 rounded-8 bg-action px-[18px] font-medium text-13 text-action-ink outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-action-hover active:bg-action-press"
      >
        Set up on GitHub
      </button>
      {failed ? (
        <p role="alert" className="m-0 mt-3 text-12 text-danger">
          GitHub's install page couldn't be opened. Try again.
        </p>
      ) : null}
      <button
        type="button"
        onClick={() => void host.session.signOut()}
        className="app-no-drag mt-6 cursor-default rounded-4 px-1 text-12 text-muted outline-none focus-ring hover:underline"
      >
        Sign out
      </button>
    </div>
  );
}

/** A sentence over the window for a few seconds. */
function useNotice(): [string | null, (notice: string) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice];
}
