import type { Api, Profile } from "@ponzu/client";
import { useLiveQuery } from "@ponzu/client/react";
import type { DeepLink } from "@ponzu/desktop/bridge";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RepoShelf } from "../cloud/create/create.ts";
import { focusCreateComposer } from "../cloud/create/focus.ts";
import { type Sent, useLanding } from "../cloud/create/landing.ts";
import { GetIphoneDialog } from "../cloud/dialogs/account-dialogs.tsx";
import type { DesignSummary, Person, ThreadItem } from "../cloud/model.ts";
import type { ResultKey } from "../cloud/search.ts";
import type { SettingsSection } from "../cloud/settings/settings-modal.tsx";
import type { RowAction } from "../cloud/sidebar/design-row.tsx";
import { Sidebar } from "../cloud/sidebar/sidebar.tsx";
import { orderSettled } from "../cloud/status.ts";
import { readDraft, writeDraft } from "../cloud/thread/composer-rules.ts";
import { ThreadRail } from "../cloud/thread/rail.tsx";
import { quietFocus } from "../cloud/ui/quiet-focus.ts";
import { paneHeld, ranJustNow } from "../cloud/ui/shortcut.ts";
import { AppWindow } from "../cloud/window/app-window.tsx";
import { DesignChrome } from "../cloud/window/design-chrome.tsx";
import type { NoticeName, OpenedVia } from "./analytics/events.ts";
import { useAnalytics, useView } from "./analytics/provider.tsx";
import { DeleteDesignDialog } from "./confirm-dialogs.tsx";
import { type CreateHandoff, CreateView, type Launch } from "./create.tsx";
import { type FreshDesign, useOpenDesign } from "./design.tsx";
import { useDesignPanes } from "./design-panes.tsx";
import type { Host } from "./host.ts";
import {
  designMembers,
  hereNow,
  membersById,
  pushableRepos,
  searchByName,
  shownWorkspace,
  toPerson,
  toSummary,
  toWorkspace,
  usableWorkspaces,
} from "./map.ts";
import { Banner, PaneMessage } from "./notices.tsx";
import { usePonzu } from "./ponzu-query.tsx";
import { ASKED_AHEAD_MS } from "./pull-request-store.ts";
import { SettingsView } from "./settings/settings-view.tsx";
import { ConnectClaudeDialog } from "./setup/connect-claude-dialog.tsx";
import { useAssetsUrls, useRowPresence, useUnchanged } from "./sidebar-data.ts";
import { filterFor, loadUi, saveUi, type UiState } from "./ui-state.ts";
import { useOnReturn } from "./use-answer.ts";

/*
 * The main window, signed in: the person's workspaces from `me`, one of them open with its
 * designs live in the sidebar, and in the main pane either a design or the create page.
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
/** Ideas take turns as the composer's placeholder until the person has made this many designs in a workspace. */
const IDEAS_UNTIL = 3;

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
  const { queries, mutations } = usePonzu();
  const meAnswer = useQuery(queries.me());
  const { refetch } = meAnswer;
  const reloadMe = useCallback(() => void refetch(), [refetch]);
  const syncGithub = useMutation(mutations.syncGithub()).mutateAsync;
  const [opening, setOpening] = useState<Opening | null>(null);
  const [notice, say] = useNotice();
  const analytics = useAnalytics();
  /** How the next design to open came to be opened: whoever opens one says. */
  const openedVia = useRef<OpenedVia>("restored");
  /** A notice, said, and counted by what it is (never its words). */
  const tell = useCallback(
    (name: NoticeName, words: string) => {
      analytics.capture("notice shown", { notice: name });
      say(words);
    },
    [analytics, say],
  );

  // Signed in without a keychain to keep the session in: say so once, now, when it matters.
  useEffect(() => {
    void host.persistence().then((persistence) => {
      if (persistence === "memory") {
        tell(
          "keychain_unavailable",
          "Ponzu can't use this computer's keychain, so you'll sign in again next time.",
        );
      } else if (persistence === "file") {
        tell(
          "session_file",
          "Signed in with a developer's session file, kept unencrypted, not in the keychain.",
        );
      }
    });
  }, [host, tell]);

  // Back in front: GitHub may have changed who reaches what (docs/cloud.md, "Keeping it true").
  const sync = useCallback(async () => {
    await syncGithub().catch(() => reloadMe());
  }, [syncGithub, reloadMe]);
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

  // A design a link names, opened on its page or board: from the shell, or the thread.
  const openDesign = useCallback(
    (link: { designId: string; pageId?: string; artboardId?: string }) => {
      host.api.designs.get(link.designId).then(
        (design) => {
          update((now) => ({
            ...now,
            workspaceId: design.workspaceId,
            designs: { ...now.designs, [design.workspaceId]: design.id },
          }));
          openedVia.current = "link";
          setOpening({
            designId: design.id,
            ...(link.pageId ? { page: link.pageId } : {}),
            ...(link.artboardId ? { artboard: link.artboardId } : {}),
          });
        },
        () => tell("design_unavailable", "That design isn't there, or you can't open it."),
      );
    },
    [host, update, tell],
  );

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
            tell(
              "install_requested",
              "Ponzu asked the organization's owners to install it. It shows here once they do.",
            );
          } else if (link.result === "failed") {
            tell("install_failed", "GitHub didn't finish setting Ponzu up. Try again.");
          }
          return;
        }
        openDesign(link);
      }),
    [host, sync, update, tell, openDesign],
  );

  // A repo chosen on the create page in another workspace: the window switches there, its
  // create page open (not the design it last showed), and the page there takes this over.
  const [handoff, setHandoff] = useState<CreateHandoff | null>(null);
  const switchWithCreate = useCallback(
    (next: CreateHandoff) => {
      setHandoff(next);
      update((now) => {
        const { [next.workspaceId]: _shown, ...designs } = now.designs;
        return { ...now, workspaceId: next.workspaceId, designs };
      });
      focusCreateComposer();
    },
    [update],
  );
  const handoffTaken = useCallback(() => setHandoff(null), []);

  const all = meAnswer.data?.workspaces ?? null;
  const usable = useMemo(() => (all ? usableWorkspaces(all) : []), [all]);
  // The same choice guided setup reads ahead before it hands the window over (setup/first-run).
  const workspace = all ? shownWorkspace(all, ui.workspaceId) : null;
  // The workspace the window showed is suspended on GitHub: it opens another, and says why.
  // What was shown counts, not what was chosen: a window that took the first workspace too.
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    const was = shownId.current;
    shownId.current = workspace?.id ?? null;
    const gone = was && was !== workspace?.id ? all?.find((w) => w.id === was) : null;
    if (gone?.suspended) {
      tell(
        "workspace_suspended",
        `Ponzu is suspended on GitHub for ${toWorkspace(gone).name}. Its designs open again once it's back.`,
      );
    }
  }, [workspace?.id, all, tell]);

  // Guided setup (FirstRun) holds the window until there is a workspace to work in, so there
  // is none only for the moment GitHub takes one away, before the gates see it.
  if (!all || !workspace) {
    return (
      <AppWindow lights={host.lights} sidebar={null} rail={null} badge={badge}>
        {notice ? <Banner>{notice}</Banner> : null}
      </AppWindow>
    );
  }
  return (
    <WorkspaceWindow
      key={workspace.id}
      host={host}
      me={me}
      user={user}
      workspace={workspace}
      workspaces={usable}
      everyWorkspace={all}
      ui={ui}
      update={update}
      badge={badge}
      opening={opening}
      onOpenDesign={openDesign}
      openedVia={openedVia}
      notice={notice}
      say={say}
      handoff={handoff}
      onHandoffTaken={handoffTaken}
      onSwitchWithCreate={switchWithCreate}
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
  user,
  workspace,
  workspaces,
  everyWorkspace,
  ui,
  update,
  badge,
  opening,
  onOpenDesign,
  openedVia,
  notice,
  say,
  handoff,
  onHandoffTaken,
  onSwitchWithCreate,
  onLostAccess,
}: {
  host: Host;
  me: Person;
  user: Profile;
  workspace: MeWorkspace;
  /** Those the window can switch to: installed and not suspended. */
  workspaces: MeWorkspace[];
  /** Every one the person is in, for Settings to say what is wrong with those that aren't. */
  everyWorkspace: MeWorkspace[];
  ui: UiState;
  update: (change: (ui: UiState) => UiState) => void;
  badge: ReactNode;
  opening: Opening | null;
  /** Opens a design a link names, on its page or board. */
  onOpenDesign: (link: { designId: string; pageId?: string; artboardId?: string }) => void;
  openedVia: { current: OpenedVia };
  notice: string | null;
  say: (notice: string) => void;
  handoff: CreateHandoff | null;
  onHandoffTaken: () => void;
  onSwitchWithCreate: (handoff: CreateHandoff) => void;
  onLostAccess: () => void;
}) {
  const id = workspace.id;
  const { queries, queryClient } = usePonzu();
  // Asked again with `me` after each sync with GitHub, as the window comes back to the front.
  const detail = useQuery(queries.workspace(id));
  const people = useMemo(() => membersById(detail.data?.members ?? []), [detail.data]);
  const repos = useMemo(
    () => (detail.data ? pushableRepos(detail.data.repos) : null),
    [detail.data],
  );
  // The create page's picker lists every usable workspace, in the switcher's order: each one's
  // name and Scratch at once (they come with `me`), its repos from the same query as they arrive.
  // One whose repos fail to load still offers its Scratch. Their answers stay in the cache, so
  // switching to one of them shows its repos at once.
  const others = useMemo(() => workspaces.filter((w) => w.id !== id), [workspaces, id]);
  const elsewhere = useQueries({
    queries: others.map((w) => queries.workspace(w.id)),
    combine: useCallback(
      (
        results: { data?: { repos: Parameters<typeof pushableRepos>[0] }; isPending: boolean }[],
      ): RepoShelf[] =>
        results.map((result, i): RepoShelf => {
          const workspace = others[i]!;
          const shelf = { workspaceId: workspace.id, name: toWorkspace(workspace).name };
          if (result.data) return { ...shelf, repos: pushableRepos(result.data.repos) };
          return { ...shelf, repos: result.isPending ? null : [] };
        }),
      [others],
    ),
  });
  const live = useLiveQuery("workspace.designs", { workspaceId: id });
  const openId = ui.designs[id] ?? null;
  // The design the create page just made, as its answer said, for it to open on.
  const [fresh, setFresh] = useState<FreshDesign | null>(null);
  const open = useOpenDesign(host, me, openId, say, fresh);
  // Share's list: everyone GitHub gives access to the open design's repo.
  const sharePeople = useQuery({
    ...queries.designPeople(openId ?? ""),
    enabled: openId !== null,
  });
  const [page, setPage] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [settledOpen, setSettledOpen] = useState(false);
  // Each opening starts Settings on the window's workspace: `opened` keys it.
  const [settings, setSettings] = useState<{
    open: boolean;
    section: SettingsSection;
    opened: number;
  }>({ open: false, section: "account", opened: 0 });
  const showSettings = useCallback(
    (open: boolean, section?: SettingsSection) =>
      setSettings((now) => ({
        open,
        section: section ?? now.section,
        opened: open && !now.open ? now.opened + 1 : now.opened,
      })),
    [],
  );
  const openSettings = useCallback(() => showSettings(true, "account"), [showSettings]);
  const openPlan = useCallback(() => showSettings(true, "plan"), [showSettings]);
  const [gettingIphone, setGettingIphone] = useState(false);
  // Kept apart from whether it is open, so the dialog's words hold as it closes.
  const [connectingClaude, setConnectingClaude] = useState(false);
  const [claudeExpired, setClaudeExpired] = useState(false);
  const [deleting, setDeleting] = useState<{ design: DesignSummary; busy: boolean } | null>(null);
  const assetsUrls = useAssetsUrls(host.api, live.rows ?? null);
  const activeIds = useMemo(
    () =>
      workspace.kind === "org"
        ? (live.rows ?? []).filter((row) => row.status === "active").map((row) => row.id)
        : [],
    [live.rows, workspace.kind],
  );
  const presence = useRowPresence(host.live, activeIds, me.id);
  const analytics = useAnalytics();
  useEffect(() => {
    analytics.workspace({ id, login: workspace.githubLogin, kind: workspace.kind });
  }, [analytics, id, workspace.githubLogin, workspace.kind]);

  // Rows a live update didn't change, and unchanged previews, stay the same objects.
  const summaries = useUnchanged(
    useMemo(
      () =>
        live.rows?.map((row) => {
          const assetsUrl = assetsUrls.get(row.id);
          return toSummary(row, {
            people,
            open: row.id === openId,
            hereNow: hereNow(presence.get(row.id) ?? [], me.id),
            ...(assetsUrl ? { assetsUrl } : {}),
          });
        }) ?? null,
      [live.rows, people, openId, presence, assetsUrls, me.id],
    ),
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
    (designId: string | null, via: OpenedVia = "sidebar") => {
      openedVia.current = via;
      update((now) => {
        const { [id]: _was, ...others } = now.designs;
        return { ...now, designs: designId ? { ...others, [id]: designId } : others };
      });
      setPage(null);
    },
    [id, update, openedVia],
  );
  useEffect(() => {
    if (!openId) return;
    analytics.capture("design opened", { design_id: openId, via: openedVia.current });
    openedVia.current = "restored";
  }, [analytics, openId, openedVia]);
  const switchPage = useCallback(
    (pageId: string) => {
      setPage(pageId);
      if (openId) analytics.capture("page switched", { design_id: openId });
    },
    [analytics, openId],
  );
  // Another design opens on its first page, or the one a link names, never the last one's.
  useEffect(() => {
    setPage(link?.page ?? null);
  }, [openId, link]);

  // The panes' toggles, for the menu's commands: the latest, without listening again each render.
  const toggles = useRef<{ sidebar: (() => void) | null; rail: (() => void) | null }>({
    sidebar: null,
    rail: null,
  });
  useEffect(
    () =>
      host.onCommand((command) => {
        if (command === "new-design") openDesign(null);
        if (command === "settings") openSettings();
        // The window's own ⌘B and ⌥⌘B take the keys first; a press they just ran isn't run again,
        // and neither toggles under a menu or a modal (paneHeld).
        if (command === "toggle-sidebar" && !ranJustNow("b") && !paneHeld("sidebar"))
          toggles.current.sidebar?.();
        if (command === "toggle-thread" && !ranJustNow("alt+b") && !paneHeld("thread"))
          toggles.current.rail?.();
      }),
    [host, openDesign, openSettings],
  );

  const addWorkspace = useCallback(() => {
    // Once GitHub is done, Ponzu comes forward and its link listener above moves on to it.
    host.installGithub({}).catch(() => say("GitHub's install page couldn't be opened. Try again."));
  }, [host, say]);

  const onOpen = useCallback((design: DesignSummary) => openDesign(design.id), [openDesign]);
  // About to open a design on a repo (the pointer or the keyboard resting on its row):
  // its pull request is asked for ahead, into the cache its chrome reads from the first frame,
  // so its action is there as it opens. Asked at most once in ASKED_AHEAD_MS, which the read on
  // opening then stands on.
  const onIntent = useCallback(
    (design: DesignSummary) => {
      if (design.project.kind !== "repo") return;
      void queryClient.prefetchQuery({
        ...queries.pullRequest(design.id),
        staleTime: ASKED_AHEAD_MS,
      });
    },
    [queryClient, queries],
  );
  const onAction = useCallback(
    (design: DesignSummary, action: Exclude<RowAction, "rename">) => {
      const failed = () => say(`“${design.name}” couldn't be changed. Try again.`);
      if (action === "copy_link") {
        navigator.clipboard.writeText(`ponzu://design/${design.id}`).then(
          () => say(`Copied the link to “${design.name}”.`),
          () => say("The link couldn't be copied. Try again."),
        );
      } else if (action === "settle" || action === "reopen") {
        host.api.designs.settle(design.id, action === "settle").catch(failed);
      } else if (action === "delete") {
        setDeleting({ design, busy: false });
      }
    },
    [host, say],
  );
  const confirmDelete = useCallback(() => {
    if (!deleting || deleting.busy) return;
    const { design } = deleting;
    setDeleting({ design, busy: true });
    host.api.designs.delete(design.id).then(
      () => {
        setDeleting(null);
        if (design.id === openId) openDesign(null);
      },
      () => {
        setDeleting(null);
        say(`“${design.name}” couldn't be deleted. Try again.`);
      },
    );
  }, [host, deleting, openId, openDesign, say]);
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
  // A brand-new personal workspace has no sidebar until its first design (onboarding 3.6), when
  // it is all the person has: with a team set up too, the sidebar is how they reach it.
  const firstDesign =
    workspace.kind === "personal" && summaries?.length === 0 && workspaces.length === 1;
  const designs = [...(active ?? []), ...(settled ?? [])];
  const sidebarOpen = ui.sidebarOpen;
  // A send from the create page: the thread's pane open for it, whatever it was left as, until
  // its beat is over (cloud/create/landing.ts); and the design's view at once, until it is made.
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  /** The design the send made, once the API has said. */
  const sentFor = useRef<string | null>(null);
  const railOpen = sent ? true : ui.railOpen;
  useLanding(sent, (open) => {
    setSent(null);
    update((now) => ({ ...now, railOpen: open }));
  });
  const railToggle = {
    open: railOpen,
    onToggle: () => {
      analytics.capture("pane toggled", {
        pane: "thread",
        open: !railOpen,
        ...(openId ? { design_id: openId } : {}),
      });
      // Pressed during a send's beat: the person's say ends it, and stands.
      setSent(null);
      update((now) => ({ ...now, railOpen: !railOpen }));
    },
  };
  // Another design opened, or the create page again, before the beat ended: the pane is left
  // closed, as the beat would have left it.
  useEffect(() => {
    if (!sent || openId === sentFor.current || (openId === null && !sentFor.current)) return;
    setSent(null);
    setLaunch(null);
    update((now) => ({ ...now, railOpen: false }));
  }, [sent, openId, update]);
  const panes = useDesignPanes({
    host,
    me,
    open: lost ? null : open,
    summary: openSummary,
    people,
    members: designMembers(
      detail.data?.members ?? [],
      openSummary?.owner?.id ?? null,
      sharePeople.data?.people,
    ),
    workspaceKind: workspace.kind,
    sidebarOpen: !firstDesign && sidebarOpen,
    rail: railToggle,
    page,
    onPage: switchPage,
    link,
    onOpenDesign: ({ designId, page, artboard }) =>
      onOpenDesign({
        designId,
        ...(page ? { pageId: page } : {}),
        ...(artboard ? { artboardId: artboard } : {}),
      }),
    seenThreadSeq: live.rows?.find((row) => row.id === openId)?.seenThreadSeq ?? null,
    say,
    onClose: () => openDesign(null),
    // The design waits on the viewer's own Claude: the guided setup's card, in a dialog.
    onConnectClaude: (expired) => {
      setClaudeExpired(expired);
      setConnectingClaude(true);
    },
  });

  // The design made: its own view takes the launch's place. What was typed into the launch's
  // composer meanwhile, and the caret, carry over to the design's.
  const launchDraft = launch ? `launch:${launch.key}` : null;
  const swapping = launch !== null && panes !== null;
  useLayoutEffect(() => {
    if (!swapping || !launchDraft) return;
    const designId = sentFor.current;
    const typed = readDraft(me.id, launchDraft);
    if (typed && designId) writeDraft(me.id, designId, typed);
    writeDraft(me.id, launchDraft, "");
    const caret = document.activeElement?.closest("#thread") != null;
    setLaunch(null);
    if (caret) {
      requestAnimationFrame(() => {
        const field = document.querySelector<HTMLTextAreaElement>(
          "#thread [data-composer-card] textarea",
        );
        if (field && document.activeElement === document.body) quietFocus(field);
      });
    }
  }, [swapping, launchDraft, me.id]);
  const launchView =
    launch && !panes
      ? {
          chrome: (
            <DesignChrome
              name={launch.name}
              sidebarOpen={!firstDesign && sidebarOpen}
              pages={[]}
              activePageId={null}
              onSelectPage={() => {}}
              onAddPage={null}
              team={null}
              pullRequest={null}
              action={null}
              rail={{ ...railToggle, signal: "working" }}
            />
          ),
          rail: railOpen ? (
            <ThreadRail
              designId={launchDraft!}
              meId={me.id}
              repoName={null}
              items={[launchLine(launch, me)]}
              older="none"
              onLoadOlder={() => {}}
              agent={{ state: "waking", status: null }}
              asks={[]}
              gate={null}
              attachments={[]}
              onAttach={() => {}}
              onRemoveAttachment={() => {}}
              onRetryAttachment={() => {}}
              // Nothing to send to until the design is made: the words stay in the field.
              onSend={() => Promise.reject(new Error("not made yet"))}
              onStop={() => {}}
              onAnswer={() => {}}
              onDismissAsk={() => {}}
              renderDrawing={() => null}
              onOpenComment={() => {}}
              onOpenArtboards={() => {}}
              onOpenPullRequest={() => {}}
              onOpenLink={(url) => host.openExternal(url)}
            />
          ) : null,
        }
      : null;

  const toggleSidebar = () => {
    analytics.capture("pane toggled", { pane: "sidebar", open: !sidebarOpen });
    update((now) => ({ ...now, sidebarOpen: !now.sidebarOpen }));
  };
  toggles.current = {
    sidebar: firstDesign ? null : toggleSidebar,
    rail: panes?.toggleRail ?? null,
  };
  useView(
    settings.open
      ? { name: "settings", section: settings.section }
      : lost
        ? { name: "no-access" }
        : panes && open
          ? { name: "design", designId: open.id, tab: panes.tab }
          : openId
            ? null
            : { name: "create" },
  );
  useEffect(() => {
    if (settings.open) analytics.capture("settings section viewed", { section: settings.section });
  }, [analytics, settings.open, settings.section]);
  useEffect(() => {
    if (lost) analytics.capture("notice shown", { notice: "no_longer_in_workspace" });
  }, [analytics, lost]);

  return (
    <AppWindow
      lights={host.lights}
      badge={badge}
      sidebar={
        firstDesign
          ? null
          : {
              open: sidebarOpen,
              onToggle: toggleSidebar,
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
                    if (key.startsWith("design:")) {
                      openDesign(key.slice("design:".length), "search");
                    }
                    setQuery(null);
                  }}
                  onOpen={onOpen}
                  onIntent={onIntent}
                  onAction={onAction}
                  onRename={onRename}
                  onNewDesign={() => {
                    openDesign(null);
                    // New design, by its button or ⌘N, is to start typing one: the caret goes
                    // to the create page's composer, whether the page was already showing or not.
                    focusCreateComposer();
                  }}
                  onSwitchWorkspace={(next) => {
                    update((now) => ({ ...now, workspaceId: next.id }));
                    // A workspace that opens on its create page is for typing into at once.
                    focusCreateComposer();
                  }}
                  onAddWorkspace={addWorkspace}
                  onSettings={openSettings}
                  onPlan={openPlan}
                  onSignOut={() => void host.session.signOut()}
                />
              ),
            }
      }
      chrome={panes?.chrome ?? launchView?.chrome}
      rail={panes?.rail ?? launchView?.rail ?? null}
      panes={{
        sidebar: ui.sidebarWidth,
        rail: ui.railWidth,
        onResize: (pane, width) =>
          update((now) => ({ ...now, [pane === "sidebar" ? "sidebarWidth" : "railWidth"]: width })),
      }}
    >
      {lost ? (
        <PaneMessage
          title={`You're no longer in ${toWorkspace(workspace).name}`}
          body="GitHub says you can't reach it any more. Ask one of its owners if that's a mistake."
          action={{ label: "Go to another workspace", onClick: onLostAccess }}
        />
      ) : panes ? (
        panes.pane
      ) : openId ? null : (
        <CreateView
          host={host}
          workspaceId={id}
          workspaceName={toWorkspace(workspace).name}
          repos={repos}
          elsewhere={elsewhere}
          handoff={handoff}
          onHandoffTaken={onHandoffTaken}
          onSwitchWorkspace={onSwitchWithCreate}
          showIdeas={
            summaries !== null &&
            summaries.filter((d) => d.owner?.id === me.id).length < IDEAS_UNTIL
          }
          onAllowMore={addWorkspace}
          onLaunch={(next) => {
            sentFor.current = null;
            setLaunch(next);
            setSent({ key: next.key, origin: next.origin });
          }}
          onLaunchFailed={() => {
            setLaunch(null);
            setSent(null);
          }}
          onCreated={(design, messageFailed) => {
            sentFor.current = design.id;
            setFresh(design);
            openDesign(design.id, "created");
            if (messageFailed) {
              analytics.capture("notice shown", { notice: "first_message_not_sent" });
              say("The design is made, but your message didn't reach Claude. Send it again.");
            }
          }}
        />
      )}
      <SettingsView
        key={settings.opened}
        host={host}
        me={me}
        user={user}
        workspaces={everyWorkspace}
        workspaceId={id}
        open={settings.open}
        onOpenChange={(open) => showSettings(open)}
        section={settings.section}
        onSectionChange={(section) => setSettings((now) => ({ ...now, section }))}
        onAddWorkspace={addWorkspace}
        onGetIphone={() => setGettingIphone(true)}
      />
      <GetIphoneDialog open={gettingIphone} onDismiss={() => setGettingIphone(false)} />
      <ConnectClaudeDialog
        host={host}
        open={connectingClaude}
        expired={claudeExpired}
        onClose={() => setConnectingClaude(false)}
      />
      {notice ? <Banner>{notice}</Banner> : null}
      <DeleteDesignDialog
        name={deleting?.design.name ?? ""}
        open={deleting !== null}
        busy={deleting?.busy ?? false}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </AppWindow>
  );
}

/** The first line of a design being made: the words just sent, on their way, as the thread shows them. */
function launchLine(launch: Launch, me: Person): ThreadItem {
  return {
    id: `launch_${launch.key}`,
    seq: 1,
    at: new Date().toISOString(),
    streaming: false,
    kind: "message",
    payload: { text: launch.text, from: me, attachments: launch.attachments, delivery: "sending" },
  };
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
