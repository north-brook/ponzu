import { useLayoutEffect, useRef } from "react";
import { quietFocus } from "../ui/quiet-focus.ts";
import { type Flight, type FlightOrigin, fly, threadComposer } from "./flight.ts";

/*
 * After a send from the create page: the composer travels to the thread (flight.ts), lands in it
 * empty and ready (the caret in it), and after a beat the thread's pane closes, having shown
 * where the conversation lives. It stays open, and is kept open, if the person has gone to it
 * since the send: moved the pointer into it, pressed or focused something in it, typed or
 * scrolled there. Its toggle (and ⌥⌘B) is the window's to watch: a press on it ends the beat too.
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
    /** Whether the composer has landed: until it has, the person's going to the pane waits. */
    let down = false;
    /** The person went to the pane while the composer travelled: it settles open on landing. */
    let gone = false;
    /** Focus our own code gives: not the person going to the pane. */
    let ours = false;
    const end = (open: boolean) => {
      if (over || gone) return;
      if (!down) {
        // The travel finishes as it began; only the beat is off. Settling now would end the
        // send, and with it the travel: the card would snap home.
        gone = true;
        unlisten();
        return;
      }
      stop();
      settleRef.current(open);
    };

    // Where the pointer was last seen to be, from before the send too: the pane sliding in
    // under a still pointer is no move of the person's.
    let at = lastPointer;
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
    function unlisten() {
      for (const [type, fn] of listening) document.removeEventListener(type, fn, true);
    }

    // Empty and ready: the caret in it, as it was in the composer that sent. Given at take-off,
    // not on landing, so keys pressed while it travels land there and not on the page's body.
    const caret = () => {
      const field = threadComposer()?.querySelector<HTMLTextAreaElement>("textarea:enabled");
      if (!field || document.activeElement === field) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      ours = true;
      quietFocus(field);
      ours = false;
    };
    const landed = () => {
      if (over) return;
      down = true;
      if (gone) {
        stop();
        settleRef.current(true);
        return;
      }
      caret();
      timer = setTimeout(() => end(false), beatMs);
    };
    caret();
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
      unlisten();
    }
    return stop;
  }, [key, beatMs]);
}

/**
 * Where the pointer last was in this window, kept from before any send, so the first move after
 * one is told from the pane sliding under a still pointer by where the pointer was before.
 */
let lastPointer: { x: number; y: number } | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointermove",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    { capture: true, passive: true },
  );
}

function threadPane(): HTMLElement | null {
  return document.getElementById("thread-pane") ?? document.getElementById("thread");
}
