/*
 * An open canvas with its thread rail and pull request tab, as the data layer will drive them:
 * local state stands in for the API, so a composition can be clicked through. Sending adds your
 * message and the agent streams a reply (then asks, if given something to ask), Stop stops it,
 * an answer goes out and the ask closes, an image uploads, and the thread loads older items as
 * you read up.
 */
import type { Doc } from "@ponzu/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  AgentActivity,
  Ask,
  CanvasSummary,
  Contributor,
  OlderItems,
  PageTab,
  PendingAttachment,
  SteerGate,
  ThreadItem,
} from "../model.ts";
import { type PullRequestTabState, PullRequestView } from "../pr-tab/pull-request-view.tsx";
import { actionBlock, type NextAction, nextAction } from "../pull-request.ts";
import { railSignal } from "../status.ts";
import { ThreadRail } from "../thread/rail.tsx";
import { CanvasChrome } from "../window/canvas-chrome.tsx";
import { BoardsPane, SHOW_BOARDS } from "./boards-pane.tsx";
import * as f from "./fixtures.ts";
import { Harness } from "./harness.tsx";
import { notice, reply as replyFixture, said } from "./thread-fixtures.ts";

const ignore = () => {};

/** What the agent says to any message, a word at a time. */
const REPLY = "On it. Keeping the green, and letting the photo do the talking in B.";

/** A comment's picture while it is drawn, as the gallery fakes it: the canvas's ground. */
const renderDrawing = (): ReactNode => <span className="block size-full bg-canvas" />;

export function CanvasHarness({
  canvases,
  canvas,
  contributors,
  pages = f.homePages,
  thread: initialThread,
  olderThread = [],
  agent: initialAgent,
  asks: initialAsks = [],
  then = [],
  gate = null,
  pullRequest = null,
  tab = "page",
  rail: initialRail = true,
  sidebar = "open",
  changes = true,
  action: forcedAction,
  boards,
}: {
  canvases: CanvasSummary[];
  canvas: CanvasSummary;
  contributors: Contributor[] | null;
  pages?: PageTab[];
  /** Null while it loads. */
  thread: ThreadItem[] | null;
  /** Older items the thread loads as you read up, fifty at a time. */
  olderThread?: ThreadItem[];
  agent: AgentActivity;
  asks?: Ask[];
  /** What the agent asks once it has answered a message. */
  then?: Ask[];
  gate?: SteerGate | null;
  pullRequest?: PullRequestTabState | null;
  tab?: "page" | "pull-request";
  rail?: boolean;
  sidebar?: "open" | "closed";
  /** The branch has commits, so a canvas with no pull request offers Create PR. */
  changes?: boolean;
  /** The next action, when it is one the summary can't give (Update branch). */
  action?: NextAction;
  /** The canvas's boards, drawn in the main pane with `&boards` (boards-pane.tsx). */
  boards?: Doc;
}) {
  const [page, setPage] = useState(pages.find((p) => p.working)?.id ?? pages[0]!.id);
  const [prTab, setPrTab] = useState(tab === "pull-request");
  // The pull request tab leaves the rail as it is: it only swaps what the main pane shows.
  const [railOpen, setRailOpen] = useState(initialRail);
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

  /** Each send starts a turn; Stop ends it, and what it had still to say goes unsaid. */
  const turn = useRef(0);
  const answer = () => {
    const mine = ++turn.current;
    const { id, seq, at } = replyFixture("");
    const words = REPLY.split(" ");
    words.forEach((_, i) =>
      later(400 + i * 60, () => {
        if (turn.current !== mine) return;
        const last = i === words.length - 1;
        const next: ThreadItem = {
          id,
          seq,
          at,
          streaming: !last,
          kind: "assistant",
          payload: { text: words.slice(0, i + 1).join(" ") },
        };
        setItems((all) =>
          i === 0
            ? [...(all ?? []), next]
            : (all ?? []).map((item) => (item.id === id ? next : item)),
        );
        if (!last) return;
        if (then.length) {
          setAsks(then);
          setAgent({ state: "needs_you", status: null });
        } else setAgent({ state: "idle", status: null });
      }),
    );
  };

  const pr = canvas.pullRequest;
  const action = forcedAction ?? nextAction(pr, changes);
  // With asks given, the count follows them as they're answered; otherwise it is the canvas's.
  const waiting =
    initialAsks.length || then.length
      ? asks.filter((a) => a.status === "open").length
      : canvas.needsYou;
  const shown = { ...canvas, needsYou: waiting, agentState: agent.state };

  const rail = (
    <ThreadRail
      canvasId={canvas.id}
      meId={f.ada.id}
      repoName={canvas.project.kind === "repo" ? canvas.project.repo.name : null}
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
        const message = said(f.ada, text);
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
        answer();
      }}
      onStop={() => {
        turn.current++;
        setAgent({ state: "idle", status: null });
        setItems((all) => [
          ...(all ?? []).map((i) => ({ ...i, streaming: false })),
          notice({ type: "stopped", by: f.ada }),
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
      onTakeOver={ignore}
      renderDrawing={renderDrawing}
      onOpenComment={ignore}
      onOpenArtboards={ignore}
      onOpenPullRequest={() => setPrTab(true)}
      onOpenLink={ignore}
    />
  );

  return (
    <Harness
      canvases={canvases.map((d) => (d.id === canvas.id ? shown : d))}
      openId={canvas.id}
      sidebar={sidebar}
      rail={railOpen}
      railContent={rail}
      chrome={(sidebarOpen) => (
        <CanvasChrome
          name={canvas.name}
          sidebarOpen={sidebarOpen}
          pages={pages}
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
                  members: f.members,
                  onOpenRepo: ignore,
                }
              : null
          }
          pullRequest={pr ? { pr, tabOpen: prTab, onToggleTab: () => setPrTab((o) => !o) } : null}
          action={
            action
              ? {
                  kind: action,
                  blocked: actionBlock(action, gate, f.ada.id),
                  // What was pressed, for the browser tests to read (`window.actionsRun`).
                  onRun: (kind: NextAction) => {
                    const w = window as { actionsRun?: string[] };
                    w.actionsRun = [...(w.actionsRun ?? []), kind];
                  },
                }
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
          viewerLogin={f.ada.login}
          onOpenLink={ignore}
          onRetry={ignore}
        />
      ) : boards && SHOW_BOARDS ? (
        <BoardsPane
          doc={boards}
          page={page}
          onPage={(id) => {
            setPrTab(false);
            setPage(id);
          }}
        />
      ) : null}
    </Harness>
  );
}
