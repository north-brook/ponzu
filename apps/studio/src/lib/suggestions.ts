import type { Idea, Suggestions } from "@ponzu/core";
import { useEffect, useState } from "react";

/** How often to ask what a run has found while it looks: often, so its cards show it reading. */
const POLL_MS = 500;

/** Nothing to suggest: no agent to ask, or a server too old to. */
const NONE: Suggestions = { agent: null, ideas: [], running: false, looking: [] };

/** What the server last said, so the home screen coming back shows it at once. */
let last: Suggestions | null = null;

/**
 * What the person's agent suggests designing (`/api/suggestions`). Each time `open` turns true,
 * the Suggested tab asks it to look again with the latest context; what it had shows meanwhile,
 * and what it finds arrives while the run goes. Failures leave what it had. It asks again when
 * `installed`, the agents found on this Mac, changes: an agent installed later brings the tab in.
 */
export function useSuggestions(open: boolean, installed = ""): Suggestions | null {
  const [state, setState] = useState<Suggestions | null>(last);
  /** A refresh is on its way: count it as running, so the tab doesn't show "nothing" first. */
  const [asking, setAsking] = useState(false);
  const got = (s: Suggestions) => {
    last = s;
    land(s.ideas);
    setState(s);
  };

  // `installed` is a dependency only to say when to ask again.
  useEffect(() => {
    let live = true;
    ask("GET").then((s) => live && got(s ?? last ?? NONE));
    return () => {
      live = false;
    };
  }, [installed]);

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

/** When each idea arrived, by `ideaKey`; 0 for one that was there from the start. */
const arrived = new Map<string, number>();
let primed = false;
let latest = 0;

export function ideaKey(idea: Pick<Idea, "name" | "project">): string {
  return `${idea.project}\n${idea.name.toLowerCase()}`;
}

/**
 * Notes when the server's answer brought each idea, in `performance.now()` time, whether or not
 * its card is on screen: now, for one not seen before, or a beat after the last to arrive, so
 * several landing together trace in one by one. The ideas the server had when the studio first
 * asked are 0: they're not new.
 */
export function land(ideas: readonly Idea[], now = performance.now()) {
  for (const i of ideas) {
    const key = ideaKey(i);
    if (arrived.has(key)) continue;
    if (!primed) {
      arrived.set(key, 0);
      continue;
    }
    latest = Math.max(now, latest + ARRIVAL_STAGGER_MS);
    arrived.set(key, latest);
  }
  primed = true;
}

/**
 * When an idea arrived, as `land` noted it: the same every render, so a card that first shows
 * after its trace would have finished shows it arrived, and one that remounts picks up mid-trace.
 * 0 for one that was there from the start.
 */
export function arrivalOf(idea: Idea): number {
  return arrived.get(ideaKey(idea)) ?? 0;
}
