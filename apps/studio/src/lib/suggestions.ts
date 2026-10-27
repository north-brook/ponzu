import type { Idea, Suggestions } from "@ponzu/core";
import { useEffect, useState } from "react";

/** How often to ask what a run has found while it looks. */
const POLL_MS = 1500;

/** Nothing to suggest: no agent to ask, or a server too old to. */
const NONE: Suggestions = { agent: null, ideas: [], running: false };

/** What the server last said, so the home screen coming back shows it at once. */
let last: Suggestions | null = null;

/**
 * What the person's agent suggests designing (`/api/suggestions`). Each time `open` turns true,
 * the Suggested tab asks it to look again with the latest context; what it had shows meanwhile,
 * and what it finds arrives while the run goes. Failures leave what it had.
 */
export function useSuggestions(open: boolean): Suggestions | null {
  const [state, setState] = useState<Suggestions | null>(last);
  /** A refresh is on its way: count it as running, so the tab doesn't show "nothing" first. */
  const [asking, setAsking] = useState(false);
  const got = (s: Suggestions) => {
    last = s;
    prime(s.ideas);
    setState(s);
  };

  useEffect(() => {
    let live = true;
    ask("GET").then((s) => live && got(s ?? last ?? NONE));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setAsking(true);
    ask("POST").then((s) => {
      if (!live) return;
      setAsking(false);
      if (s) got(s);
    });
    return () => {
      live = false;
      setAsking(false);
    };
  }, [open]);

  const running = Boolean(state?.running);
  useEffect(() => {
    if (!running) return;
    let live = true;
    const t = setInterval(() => {
      ask("GET").then((s) => live && s && got(s));
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [running]);

  if (!state) return null;
  return asking && !state.running ? { ...state, running: true } : state;
}

async function ask(method: "GET" | "POST"): Promise<Suggestions | null> {
  const path = method === "POST" ? "/api/suggestions/refresh" : "/api/suggestions";
  try {
    const res = await fetch(`${window.location.origin}${path}`, { method });
    if (!res.ok) return null;
    const s = (await res.json()) as Suggestions;
    return Array.isArray(s?.ideas) ? s : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Arrivals                                                           */
/* ------------------------------------------------------------------ */

/** Between one idea tracing in and the next, when several land together. */
export const ARRIVAL_STAGGER_MS = 700;

/** When each idea arrived on screen, by `ideaKey`; 0 for one that was there from the start. */
const arrived = new Map<string, number>();
let primed = false;
let latest = 0;

export function ideaKey(idea: Pick<Idea, "name" | "project">): string {
  return `${idea.project}\n${idea.name.toLowerCase()}`;
}

/** The ideas the server had when the studio first asked show at once: they're not new. */
function prime(ideas: Idea[]) {
  if (primed) return;
  primed = true;
  for (const i of ideas) arrived.set(ideaKey(i), 0);
}

/**
 * When an idea arrives on screen, in `performance.now()` time: now, for one not seen before, or
 * a beat after the last to arrive, so several landing together trace in one by one. The same
 * time every render after, so a card that remounts picks up mid-trace. 0 for one already there.
 */
export function arrivalOf(idea: Idea): number {
  const key = ideaKey(idea);
  let at = arrived.get(key);
  if (at === undefined) {
    at = Math.max(performance.now(), latest + ARRIVAL_STAGGER_MS);
    latest = at;
    arrived.set(key, at);
  }
  return at;
}
