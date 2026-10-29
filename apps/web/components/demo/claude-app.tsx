"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";
import { type Entry, indexIn, type Script } from "./script";

/*
 * The coding-agent app beside the canvas, rebuilt from reference screenshots in both color
 * schemes: the conversation, collapsed tool runs, a live plan, and the composer. Colors were
 * sampled from those screenshots; see `.dm-app` in demo.css.
 */

/** The Ponzu tool running on a beat: the script's, else a screenshot while you look round a page,
 * or waiting for activity while you comment. */
const toolOn = (script: Script, id: string | undefined) => {
  if (id === undefined) return undefined;
  if (/-look/.test(id)) return "screenshot";
  return script.tools[id] ?? (/^c\d-/.test(id) ? "wait for activity" : undefined);
};

export function ClaudeApp({
  script,
  beat,
  t,
  big,
}: {
  script: Script;
  beat: number;
  t: number;
  big: boolean;
}) {
  const at = (id: string) => beat >= indexIn(script, id);
  // The story opens with your prompt already sent.
  const working = !at("rest");
  const tool = toolOn(script, script.beats[beat]?.id);
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
      <TitleBar title={script.title} />

      <div ref={scroll} className="dm-app-thread">
        <You>{script.prompt}</You>
        {script.thread.map((entry) => (
          <Line key={keyOf(entry)} entry={entry} at={at} tool={tool} />
        ))}
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

const keyOf = (entry: Entry) =>
  "say" in entry ? entry.say : "plan" in entry ? `plan:${entry.at}` : `tools:${entry.from}`;

/** One thing in the thread, once its beat has come. */
function Line({
  entry,
  at,
  tool,
}: {
  entry: Entry;
  at: (id: string) => boolean;
  tool: string | undefined;
}) {
  if ("tools" in entry) return <Tools segment={entry} at={at} tool={tool} />;
  if (!at(entry.at)) return null;
  if ("plan" in entry) return <Plan steps={entry.plan} at={at} />;
  return <Say>{entry.say}</Say>;
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
  segment: { tools: number; from: string; to: string };
  at: (id: string) => boolean;
  tool: string | undefined;
}) {
  if (!at(segment.from)) return null;
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
function Plan({
  steps,
  at,
}: {
  steps: { label: string; from: string; to: string }[];
  at: (id: string) => boolean;
}) {
  return (
    <div className="dm-line dm-app-plan">
      {steps.map((step) => {
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
