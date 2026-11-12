import { useLayoutEffect, useRef } from "react";
import { quietFocus } from "../ui/quiet-focus.ts";
import { type Flight, type FlightOrigin, fly, threadComposer } from "./flight.ts";

/*
 * After a send from the create page: the composer travels to the thread (flight.ts), lands in it
 * empty and ready (the caret in it), and after a beat the thread's pane closes, having shown
 * where the conversation lives. It stays open, and is kept open, if the person has gone to it
 * since the send: moved the pointer into it, pressed or focused something in it, typed or
 * scrolled there. Its toggle (and ⌘J) is the window's to watch: a press on it ends the beat too.
 */

/** How long the thread's pane stays open once the composer has landed, before it closes. */
export const LANDING_BEAT_MS = 1400;

/** A send from the create page, from the moment it went: each has its own key. */
export interface Sent {
  key: string;
  /** Where the composer was; null where it doesn't travel (reduced motion). */
  origin: FlightOrigin | null;
}

/**
 * Runs a send's travel and its beat. `onSettle` says how the thread's pane ends: closed, once the
 * beat has run out untouched, or open, the moment the person goes to it. Call with `sent` null
 * once settled, or when a send came to nothing (it failed): whatever is still under way stops
 * where it is and nothing is settled.
 *
 * Mount it with the window that holds the rail: by its layout effect the rail's content is in
 * the page, its composer already where it will rest.
 */
export function useLanding(
  sent: Sent | null,
  onSettle: (open: boolean) => void,
  beatMs = LANDING_BEAT_MS,
): void {
  const settleRef = useRef(onSettle);
  settleRef.current = onSettle;
  const key = sent?.key ?? null;
  const origin = useRef(sent?.origin ?? null);
  origin.current = sent?.origin ?? null;

  useLayoutEffect(() => {
    if (key === null) return;
    let over = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let flight: Flight | null = null;
    /** Focus our own code gives: not the person going to the pane. */
    let ours = false;
    const end = (open: boolean) => {
      if (over) return;
      stop();
      settleRef.current(open);
    };

    // Where the pointer was last seen to be: the pane sliding in under a still pointer is no
    // move of the person's.
    let at: { x: number; y: number } | null = null;
    const inPane = (e: Event) => e.target instanceof Node && !!threadPane()?.contains(e.target);
    const onMove = (e: PointerEvent) => {
      const moved = at !== null && (at.x !== e.clientX || at.y !== e.clientY);
      at = { x: e.clientX, y: e.clientY };
      if (moved && inPane(e)) end(true);
    };
    const onTouch = (e: Event) => {
      if (inPane(e)) end(true);
    };
    const onFocus = (e: Event) => {
      if (!ours) onTouch(e);
    };
    const listening: [string, EventListener][] = [
      ["pointermove", onMove as EventListener],
      ["pointerdown", onTouch],
      ["wheel", onTouch],
      ["keydown", onTouch],
      ["focusin", onFocus],
    ];
    for (const [type, fn] of listening) document.addEventListener(type, fn, true);

    const landed = () => {
      if (over) return;
      // Empty and ready: the caret in it, as it was in the composer that sent.
      const field = threadComposer()?.querySelector<HTMLTextAreaElement>("textarea:enabled");
      if (field && !document.querySelector('[role="dialog"], [role="menu"]')) {
        ours = true;
        quietFocus(field);
        ours = false;
      }
      timer = setTimeout(() => end(false), beatMs);
    };
    const target = threadComposer();
    if (origin.current && target) {
      flight = fly(origin.current, target);
      flight.landed.then(landed);
    } else {
      landed();
    }

    function stop() {
      over = true;
      clearTimeout(timer);
      flight?.land();
      for (const [type, fn] of listening) document.removeEventListener(type, fn, true);
    }
    return stop;
  }, [key, beatMs]);
}

function threadPane(): HTMLElement | null {
  return document.getElementById("thread-pane") ?? document.getElementById("thread");
}
