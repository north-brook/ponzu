"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";
import { BEATS, type BeatId, index, PROMPT } from "./script";

/*
 * The coding-agent app beside the canvas, rebuilt from reference screenshots in both color
 * schemes: the conversation, collapsed tool runs, a live plan, and the composer. Colors were
 * sampled from those screenshots; see `.dm-app` in demo.css.
 */

type Segment = { from: BeatId; to: BeatId; tools: number };

/** Runs of tool calls between Claude's messages. A finished run collapses to "Used N tools". */
const SEGMENTS: Segment[] = [
  { from: "app-page", to: "motion-page", tools: 6 },
  { from: "motion-page", to: "c0-cursor", tools: 4 },
  { from: "c0-cursor", to: "c0-reply", tools: 2 },
  { from: "c0-reply", to: "explore-page", tools: 1 },
  { from: "explore-page", to: "c1-cursor", tools: 5 },
  { from: "c1-cursor", to: "c3-heard", tools: 1 },
  { from: "rework", to: "web-page", tools: 4 },
  { from: "web-page", to: "c4-cursor", tools: 3 },
  { from: "c4-cursor", to: "c4-heard", tools: 1 },
  { from: "revise", to: "store-page", tools: 3 },
  { from: "store-page", to: "rest", tools: 4 },
];

/** The run of tools that starts on a beat. */
const run = (from: BeatId) => SEGMENTS.find((s) => s.from === from);

/** The Ponzu tool running on each beat, as the app names it. Comment beats wait for activity. */
const TOOL: Partial<Record<BeatId, string>> = {
  "app-page": "update page",
  app: "write html",
  "motion-page": "create page",
  motion: "write html",
  "explore-page": "create page",
  explore: "write html",
  rework: "write html",
  "rework-2": "write html",
  "web-page": "create page",
  web: "write html",
  revise: "write html",
  "c0-heard": "reply",
  "store-page": "create page",
  store: "write html",
};

/** Looking round a page, Claude screenshots it; while you comment, it waits for you. */
const toolOn = (id: BeatId | undefined) => {
  if (id === undefined) return undefined;
  if (/-look/.test(id)) return "screenshot";
  return TOOL[id] ?? (/^c\d-/.test(id) ? "wait for activity" : undefined);
};

/** Claude's plan for the first turn, and the beats between which each step is in progress. */
const PLAN: { label: string; from: BeatId; to: BeatId }[] = [
  { label: "Every screen and animation, from apps/native", from: "think", to: "explore-page" },
  { label: "Game feel: studies and three directions", from: "explore-page", to: "web-page" },
  { label: "Website hero, desktop and mobile", from: "web-page", to: "store-page" },
  { label: "App Store screenshots, three directions", from: "store-page", to: "rest" },
];

export function ClaudeApp({ beat, t, big }: { beat: number; t: number; big: boolean }) {
  const at = (id: BeatId) => beat >= index(id);
  // The story opens with your prompt already sent.
  const working = !at("rest");
  const id = BEATS[beat]?.id;
  const tool = toolOn(id);
  const tokens = 1.2 + beat * 0.9 + t * 0.8;

  // New messages arrive at the bottom; once the thread fills the window, it follows them. The
  // thread only grows when the beat changes, so measure then, not on every tick.
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [beat]);

  return (
    <div className="dm-window dm-app min-h-0" style={{ fontSize: big ? 16 : 12.5 }}>
      <TitleBar title="Rebuild Seekle in Ponzu" />

      <div ref={scroll} className="dm-app-thread">
        <You>{PROMPT}</You>
        {at("think") && (
          <Say>
            Reading apps/native first, so every size, string and timing comes from the source.
          </Say>
        )}
        {at("think") && <Plan at={at} />}
        <Tools segment={run("app-page")} at={at} tool={tool} />
        {at("motion-page") && (
          <Say>Five screens up. Now every animation, looping on the canvas.</Say>
        )}
        <Tools segment={run("motion-page")} at={at} tool={tool} />
        <Tools segment={run("c0-cursor")} at={at} tool={tool} />
        {at("c0-reply") && (
          <Say>Answered your question on the Motion page: most screens already rise in.</Say>
        )}
        <Tools segment={run("c0-reply")} at={at} tool={tool} />
        {at("explore-page") && (
          <Say>
            20 loops, timed from lib/motion.ts. Now the game feel: four takes each on the found set,
            the score and the clock, and three full screens combining them.
          </Say>
        )}
        <Tools segment={run("explore-page")} at={at} tool={tool} />
        {at("c1-cursor") && (
          <Say>
            Everything loops on one 3.2s beat, so they compare fairly. Comment on any of them.
          </Say>
        )}
        <Tools segment={run("c1-cursor")} at={at} tool={tool} />
        {at("c3-heard") && (
          <Say>
            Three comments. Taking the “found” label and the green off Collect, moving the score to
            the middle with the clock top right, then carrying both into the directions, D2 first.
          </Say>
        )}
        <Tools segment={run("rework")} at={at} tool={tool} />
        {at("web-page") && (
          <Say>
            D2 is the one: no label, no green, a rolling score and a quiet clock. Now the website
            hero.
          </Say>
        )}
        <Tools segment={run("web-page")} at={at} tool={tool} />
        <Tools segment={run("c4-cursor")} at={at} tool={tool} />
        {at("c4-heard") && (
          <Say>
            New comment on the hero. Five friends will orbit the phone: behind it at the top, in
            front at the bottom.
          </Say>
        )}
        <Tools segment={run("revise")} at={at} tool={tool} />
        {at("store-page") && (
          <Say>Orbiting on desktop and mobile. Last, the App Store screenshots.</Say>
        )}
        <Tools segment={run("store-page")} at={at} tool={tool} />
        {at("rest") && (
          <Say>
            Done: night table, ink panorama and close-up, five frames each, built from the real
            screens. Your four requests are resolved, and your question's answered.
          </Say>
        )}
      </div>

      <div className="dm-app-status">
        {working && (
          <>
            <Dots />
            <span className="dm-app-soft">{tool ? `Using ponzu: ${tool}` : "Thinking"}</span>
            <span className="dm-app-muted">{tokens.toFixed(1)}k tokens</span>
          </>
        )}
      </div>

      <Composer working={working} />
    </div>
  );
}

function TitleBar({ title }: { title: string }) {
  return (
    <div className="dm-app-bar">
      <span className="dm-lights">
        <i />
        <i />
        <i />
      </span>
      <span className="dm-app-icons dm-app-soft">
        <Glyph d="M3.5 4.5h17v15h-17zM9.5 4.5v15" />
        <Glyph d="M14 6.5 8.5 12l5.5 5.5M9 12h11" />
        <Glyph d="M10 6.5l5.5 5.5-5.5 5.5M15 12H4" className="dm-app-faint" />
      </span>
      <span className="dm-app-title">
        <span className="truncate">{title}</span>
        <Glyph d="M6 9.5l6 6 6-6" small />
      </span>
      <span className="dm-app-icons dm-app-soft ml-auto">
        <Glyph d="M3.5 5.5h17v13h-17zM7.5 10h2M12 10h4.5M7.5 14h2M12 14h4.5" />
        <i className="dm-app-divider" />
        <Glyph d="M5 7.5l5 4.5-5 4.5M12 17.5h7" />
        <Glyph d="M4.5 4.5h15v15h-15zM12 8v5M9.5 10.5h5M9.5 16h5" />
        <Glyph d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5S14.6 18.1 12 20.5M12 3.5C9.4 5.9 8.2 8.7 8.2 12s1.2 6.1 3.8 8.5" />
        <Glyph d="M3.5 6.5a1 1 0 0 1 1-1h5l2 2.5h8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z" />
        <Glyph d="M12 6.2v.1M12 12v.1M12 17.8v.1" dots />
      </span>
    </div>
  );
}

/** A 24px stroke icon, drawn at the app's toolbar weight. */
function Glyph({
  d,
  className = "",
  small = false,
  dots = false,
}: {
  d: string;
  className?: string;
  small?: boolean;
  dots?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${small ? "dm-app-glyph-sm" : "dm-app-glyph"} ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={dots ? 3 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function You({ children }: { children: ReactNode }) {
  return (
    <div className="dm-line flex justify-end">
      <div className="dm-app-bubble">{children}</div>
    </div>
  );
}

function Say({ children }: { children: ReactNode }) {
  return <p className="dm-line m-0">{children}</p>;
}

/** A run of tool calls: live while it runs, then folded into one quiet line. */
function Tools({
  segment,
  at,
  tool,
}: {
  segment: Segment | undefined;
  at: (id: BeatId) => boolean;
  tool: string | undefined;
}) {
  if (!segment || !at(segment.from)) return null;
  const done = at(segment.to);
  return (
    <div className="dm-line dm-app-muted flex items-center gap-[0.3em]">
      {done
        ? `Used ${segment.tools} ${segment.tools === 1 ? "tool" : "tools"}`
        : `Using ponzu: ${tool ?? "…"}`}
      <Glyph d="M9.5 6.5l5.5 5.5-5.5 5.5" small />
    </div>
  );
}

/** Claude's to-do list for the turn: done, in progress, and still to do. */
function Plan({ at }: { at: (id: BeatId) => boolean }) {
  return (
    <div className="dm-line dm-app-plan">
      {PLAN.map((step) => {
        const state = at(step.to) ? "done" : at(step.from) ? "active" : "todo";
        return (
          <div key={step.label} className="dm-app-step" data-state={state}>
            <StepIcon state={state} />
            <span>{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function StepIcon({ state }: { state: "done" | "active" | "todo" }) {
  if (state === "done")
    return (
      <svg viewBox="0 0 16 16" className="dm-app-step-icon" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path
          d="M5 8.2l2 2 4-4.4"
          fill="none"
          stroke="var(--app-bg)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (state === "active")
    return (
      <svg viewBox="0 0 16 16" className="dm-app-step-icon dm-app-spin" aria-hidden="true">
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="var(--app-rule)" strokeWidth="1.4" />
        <path
          d="M8 1.6a6.4 6.4 0 0 1 6.4 6.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" className="dm-app-step-icon dm-app-faint" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="2.2 2.1"
      />
    </svg>
  );
}

/** The three orange dots the app shows while Claude works. */
function Dots() {
  return (
    <span className="dm-app-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function Composer({ working }: { working: boolean }) {
  return (
    <div className="dm-app-foot">
      <div className="dm-app-composer">
        <Glyph d="M12 5v14M5 12h14" className="dm-app-soft" />
        <span className="min-w-0 flex-1 truncate">
          <span className="dm-app-muted">
            {!working ? <span className="dm-app-caret" /> : null}↵ to send, ⌘↵ to queue for later
          </span>
        </span>
        {working ? (
          <svg viewBox="0 0 24 24" className="dm-app-glyph dm-app-ink" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <rect x="9" y="9" width="6" height="6" rx="1.2" fill="currentColor" />
          </svg>
        ) : (
          <span className="dm-app-send" data-ready={false}>
            <Glyph d="M12 18V6M6.5 11.5 12 6l5.5 5.5" />
          </span>
        )}
        <Glyph
          d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3ZM6 11.5a6 6 0 0 0 12 0M12 17.5v3"
          className="dm-app-soft"
        />
      </div>
      <div className="dm-app-meta">
        <span className="dm-app-soft">Auto</span>
        <span className="ml-auto dm-app-soft">Opus 5.5</span>
        <span className="dm-app-muted">High</span>
        <svg viewBox="0 0 16 16" className="dm-app-ring" aria-hidden="true">
          <circle cx="8" cy="8" r="5.6" fill="none" stroke="var(--app-rule)" strokeWidth="2" />
          <path
            d="M8 2.4a5.6 5.6 0 0 1 5.2 3.5"
            fill="none"
            stroke="#2a79d6"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}
