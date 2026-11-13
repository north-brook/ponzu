/*
 * A turn played out in the rail as the API would deliver it, for the browser tests and for
 * watching: the person sends, the head says the agent is working and what on, the turn's item
 * opens, text streams in between tool calls (the turn's log growing after each message as the
 * agent carries on), and the turn ends on the thread's channel a moment before the head says
 * idle, as the two channels can arrive. `window.playTurn()` starts it. With `earlier`, a long
 * thread sits above it, for reading up while it ends.
 */
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { AgentActivity, ThreadItem } from "../model.ts";
import { ThreadRail } from "../thread/rail.tsx";
import { TipProvider } from "../ui/tooltip.tsx";
import * as f from "./fixtures.ts";
import { longThread } from "./thread-fixtures.ts";

const ignore = () => {};
const AT = "2026-11-10T16:00:00Z";

type Step = { at: number; items?: (all: ThreadItem[]) => ThreadItem[]; agent?: AgentActivity };

const ask: ThreadItem = {
  id: "ti_live_ask",
  seq: 1_000_001,
  at: AT,
  streaming: false,
  kind: "message",
  payload: { text: "Two small boards, and the token file.", from: f.ada, attachments: [] },
};
/** The turn's log as it grows: what it did before it spoke, then after its first message. */
const LOG = [
  { after: null, text: "Read the canvas", count: 1 },
  { after: null, text: 'Drew "Plan"', count: 1 },
  { after: "ti_live_a", text: 'Drew "Plan ready"', count: 2 },
  { after: "ti_live_a", text: "Edited styles/tokens.css", count: 1 },
];
const turnItem = (streaming: boolean, final: string | null, logged: number): ThreadItem => ({
  id: "ti_live_turn",
  seq: 1_000_002,
  at: AT,
  streaming,
  kind: "tool",
  payload: {
    label: streaming ? "Thinking" : "Worked on 2 boards and 1 file",
    steps: 5,
    artboards: [],
    turn: {
      ended: streaming ? null : "done",
      ms: 64_000,
      final,
      boards: 2,
      files: 1,
      log: LOG.slice(0, logged),
    },
  },
});
const text = (id: string, seq: number, words: string, streaming: boolean): ThreadItem => ({
  id,
  seq,
  at: AT,
  streaming,
  kind: "assistant",
  payload: { text: words },
});
const put = (item: ThreadItem) => (all: ThreadItem[]) =>
  all.some((i) => i.id === item.id)
    ? all.map((i) => (i.id === item.id ? item : i))
    : [...all, item];

/** Its first message, an aside once it carries on: Markdown in it, as the agent writes. */
const FIRST = "Drew **Plan**. Now `Plan ready`, then the tokens.";
const LAST =
  "Done: **Plan** and **Plan ready** are on the canvas, and the tokens file has the new spacing.";
const working = (status: string): AgentActivity => ({ state: "working", status });

const SCRIPT: Step[] = [
  { at: 0, items: put(ask) },
  { at: 150, agent: working("Thinking") },
  { at: 300, items: put(turnItem(true, null, 1)), agent: working("Reading the canvas") },
  { at: 450, items: put(turnItem(true, null, 2)), agent: working('Drawing "Plan"') },
  { at: 600, agent: working("Thinking") },
  ...FIRST.split(" ").map((_, i, words) => ({
    at: 650 + i * 40,
    items: put(text("ti_live_a", 1_000_003, words.slice(0, i + 1).join(" "), i < words.length - 1)),
  })),
  // It carries on after its first message: that message is an aside from here.
  { at: 1100, items: put(turnItem(true, null, 3)), agent: working('Drawing "Plan ready"') },
  { at: 1250, items: put(turnItem(true, null, 4)), agent: working("Editing styles/tokens.css") },
  { at: 1400, agent: working("Thinking") },
  ...LAST.split(" ").map((_, i, words) => ({
    at: 1450 + i * 30,
    items: put(text("ti_live_b", 1_000_004, words.slice(0, i + 1).join(" "), i < words.length - 1)),
  })),
  // The thread's channel says the turn ended before the head's does.
  { at: 2000, items: put(turnItem(false, "ti_live_b", 4)) },
  { at: 2150, agent: { state: "idle", status: null } },
];

export function LiveTurnRail({ earlier = false }: { earlier?: boolean }) {
  const [items, setItems] = useState<ThreadItem[]>(() => (earlier ? longThread(60) : []));
  const [agent, setAgent] = useState<AgentActivity>({ state: "idle", status: null });
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const play = () =>
      new Promise<void>((done) => {
        for (const step of SCRIPT)
          timers.current.push(
            // Each step its own commit, made before its timer returns. Left to React, steps whose
            // timers a busy page runs back to back are batched into one render, and a state
            // between them never reaches the page, which no test of every state can then see.
            window.setTimeout(
              () =>
                flushSync(() => {
                  if (step.items) setItems(step.items);
                  if (step.agent) setAgent(step.agent);
                }),
              step.at,
            ),
          );
        timers.current.push(window.setTimeout(done, SCRIPT.at(-1)!.at + 200));
      });
    (window as { playTurn?: () => Promise<void> }).playTurn = play;
    return () => timers.current.forEach(clearTimeout);
  }, []);
  return (
    <TipProvider>
      <div className="flex h-[560px] w-[360px] flex-col bg-chrome px-2.5 pb-2.5">
        <ThreadRail
          canvasId="live-turn"
          meId={f.ada.id}
          repoName="fernwood"
          items={items}
          older="none"
          onLoadOlder={ignore}
          agent={agent}
          asks={[]}
          gate={null}
          attachments={[]}
          onAttach={ignore}
          onRemoveAttachment={ignore}
          onRetryAttachment={ignore}
          onSend={ignore}
          onStop={ignore}
          onAnswer={ignore}
          onDismissAsk={ignore}
          renderDrawing={() => <span className="block size-full bg-canvas" />}
          onOpenComment={ignore}
          onOpenArtboards={ignore}
          onOpenPullRequest={ignore}
          onOpenLink={ignore}
        />
      </div>
    </TipProvider>
  );
}
