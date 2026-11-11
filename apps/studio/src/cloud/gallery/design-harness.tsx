/*
 * An open design with its thread rail and pull request tab, as the data layer will drive them:
 * local state stands in for the API, so a composition can be clicked through. Sending adds your
 * message and sets the agent working, Stop stops it, an answer goes out and the ask closes, an
 * image uploads, and the thread loads older items as you read up.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  AgentActivity,
  Ask,
  Contributor,
  DesignSummary,
  OlderItems,
  PageTab,
  PendingAttachment,
  SteerGate,
  ThreadItem,
} from "../model.ts";
import { type PullRequestTabState, PullRequestView } from "../pr-tab/pull-request-view.tsx";
import { actionBlock, nextAction } from "../pull-request.ts";
import { railSignal } from "../status.ts";
import { ThreadRail } from "../thread/rail.tsx";
import { DesignChrome } from "../window/design-chrome.tsx";
import * as f from "./fixtures.ts";
import { Harness } from "./harness.tsx";
import { notice, said } from "./thread-fixtures.ts";

const ignore = () => {};

/**
 * The canvas's miniature of a board, as the gallery fakes it: the boards' "Hero" at a quarter
 * scale. Its colors are the sample shop's, not the app's, so they are written out as the design
 * draws them.
 */
const renderBoard = (): ReactNode => (
  <div
    style={{
      zoom: 0.26,
      width: 500,
      height: 312,
      display: "flex",
      flexDirection: "column",
      gap: 16,
      padding: "24px 28px",
      background: "#f3efe6",
      color: "#1f2a1d",
      fontFamily: "'Instrument Serif', Georgia, serif",
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        font: "500 10px/1 var(--font-sans)",
        color: "#4b5a46",
      }}
    >
      <span>FERNWOOD</span>
      <span>Shop · Care</span>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 20, flex: 1 }}>
      <span style={{ fontSize: 38, lineHeight: 1 }}>Plants that outlive your lease</span>
      <div
        style={{
          borderRadius: 6,
          background: "radial-gradient(circle at 40% 35%,#9bb48a,#4f6b45 60%,#2f4429)",
        }}
      />
    </div>
  </div>
);

export function DesignHarness({
  designs,
  design,
  contributors,
  pages = f.homePages,
  thread: initialThread,
  olderThread = [],
  agent: initialAgent,
  asks: initialAsks = [],
  gate = null,
  pullRequest = null,
  tab = "page",
  rail: initialRail = true,
  changes = true,
}: {
  designs: DesignSummary[];
  design: DesignSummary;
  contributors: Contributor[] | null;
  pages?: PageTab[];
  /** Null while it loads. */
  thread: ThreadItem[] | null;
  /** Older items the thread loads as you read up, fifty at a time. */
  olderThread?: ThreadItem[];
  agent: AgentActivity;
  asks?: Ask[];
  gate?: SteerGate | null;
  pullRequest?: PullRequestTabState | null;
  tab?: "page" | "pull-request";
  rail?: boolean;
  /** The branch has commits, so a design with no pull request offers Create PR. */
  changes?: boolean;
}) {
  const [page, setPage] = useState(pages.find((p) => p.working)?.id ?? pages[0]!.id);
  const [prTab, setPrTab] = useState(tab === "pull-request");
  const [railOpen, setRailOpen] = useState(initialRail && tab === "page");
  // Opening the pull request tab folds the rail away; leaving it puts the rail back as it was.
  const railBefore = useRef(initialRail);
  const [items, setItems] = useState(initialThread);
  const [older, setOlder] = useState(olderThread);
  const [olderState, setOlderState] = useState<OlderItems>(olderThread.length ? "more" : "none");
  const [agent, setAgent] = useState(initialAgent);
  const [asks, setAsks] = useState(initialAsks);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, ms));
  };

  const openTab = (open: boolean) => {
    if (open === prTab) return;
    if (open) {
      railBefore.current = railOpen;
      setRailOpen(false);
    } else setRailOpen(railBefore.current);
    setPrTab(open);
  };

  const pr = design.pullRequest;
  const action = nextAction(pr, changes);
  // With asks given, the count follows them as they're answered; otherwise it is the design's.
  const waiting = initialAsks.length
    ? asks.filter((a) => a.status === "open").length
    : design.needsYou;
  const shown = { ...design, needsYou: waiting, agentState: agent.state };

  const rail = (
    <ThreadRail
      designId={design.id}
      meId={f.bryce.id}
      repoName={design.project.kind === "repo" ? design.project.repo.name : null}
      items={items}
      older={olderState}
      onLoadOlder={() => {
        setOlderState("loading");
        later(500, () => {
          const page = older.slice(-50);
          setOlder((o) => o.slice(0, -50));
          setItems((all) => [...page, ...(all ?? [])]);
          setOlderState(older.length > 50 ? "more" : "none");
        });
      }}
      agent={agent}
      asks={asks}
      gate={gate}
      attachments={attachments}
      onAttach={(files) => {
        const added = files.map((file) => ({
          id: crypto.randomUUID(),
          name: file.name,
          previewUrl: URL.createObjectURL(file),
          status: "uploading" as const,
        }));
        setAttachments((a) => [...a, ...added]);
        later(900, () =>
          setAttachments((a) =>
            a.map((x) => (added.some((y) => y.id === x.id) ? { ...x, status: "ready" } : x)),
          ),
        );
      }}
      onRemoveAttachment={(id) => setAttachments((a) => a.filter((x) => x.id !== id))}
      onRetryAttachment={(id) =>
        setAttachments((a) => a.map((x) => (x.id === id ? { ...x, status: "ready" } : x)))
      }
      onSend={(text) => {
        const message = said(f.bryce, text);
        if (message.kind === "message") {
          message.payload.attachments = attachments.map((a) => ({
            ref: `assets/${a.name}`,
            url: a.previewUrl,
            contentType: "image/png",
          }));
        }
        setAttachments([]);
        setItems((all) => [...(all ?? []), message]);
        setAgent({ state: "working", status: "Reading your message" });
      }}
      onStop={() => {
        setAgent({ state: "idle", status: null });
        setItems((all) => [
          ...(all ?? []).map((i) => ({ ...i, streaming: false })),
          notice({ type: "stopped", by: f.bryce }),
        ]);
      }}
      onAnswer={(id) => {
        setAsks((all) => all.map((a) => (a.id === id ? { ...a, status: "sending" } : a)));
        later(700, () => {
          setAsks((all) => all.filter((a) => a.id !== id));
          setAgent({ state: "working", status: "Taking your answer" });
        });
      }}
      onDismissAsk={(id) => setAsks((all) => all.filter((a) => a.id !== id))}
      onConnectClaude={ignore}
      renderBoard={renderBoard}
      onOpenComment={ignore}
      onOpenArtboards={ignore}
      onOpenPullRequest={() => openTab(true)}
      onOpenLink={ignore}
    />
  );

  return (
    <Harness
      designs={designs.map((d) => (d.id === design.id ? shown : d))}
      openId={design.id}
      rail={railOpen}
      railContent={rail}
      chrome={(sidebarOpen) => (
        <DesignChrome
          name={design.name}
          sidebarOpen={sidebarOpen}
          pages={pages}
          activePageId={prTab ? null : page}
          onSelectPage={(id) => {
            openTab(false);
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
          pullRequest={pr ? { pr, tabOpen: prTab, onToggleTab: () => openTab(!prTab) } : null}
          action={
            action
              ? { kind: action, blocked: actionBlock(action, gate, f.bryce.id), onRun: ignore }
              : null
          }
          rail={{
            open: railOpen,
            signal: railSignal(shown, false),
            onToggle: () => setRailOpen((o) => !o),
          }}
        />
      )}
    >
      {prTab && pullRequest ? (
        <PullRequestView
          state={pullRequest}
          viewerLogin={f.bryce.login}
          onOpenLink={ignore}
          onRetry={ignore}
        />
      ) : null}
    </Harness>
  );
}
