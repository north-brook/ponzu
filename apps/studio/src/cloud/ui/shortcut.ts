import { isTyping, useModifierHint } from "@ponzu/canvas/modifier-hint";
import { useEffect, useRef } from "react";
import { useAnalytics } from "../../app/analytics/provider.tsx";

/** Key presses already counted: two shortcuts on one key (⌘, has two) are one use. */
const counted = new WeakSet<KeyboardEvent>();

/** When each shortcut last ran, by key: a menu item with the same accelerator checks it. */
const ran = new Map<string, number>();

/**
 * Runs `handler` on ⌘ (Ctrl off the Mac) plus `key`, anywhere in the window, text fields
 * included: none of the app's take rich text, so no shortcut here shadows one of theirs. `key`
 * is the KeyboardEvent key, lowercase: "k", "n", "j", "b", ",", "p", "enter"; `shift` asks for ⇧
 * as well (⌘⇧↵). Each use is counted (`hotkey used`), by key.
 */
export function useShortcut(
  key: string,
  handler: () => void,
  enabled = true,
  { shift = false }: { shift?: boolean } = {},
): void {
  const latest = useRef(handler);
  latest.current = handler;
  const analytics = useAnalytics();
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey !== shift || e.altKey) return;
      if (e.key.toLowerCase() !== key) return;
      e.preventDefault();
      ran.set(key, performance.now());
      if (!counted.has(e)) {
        counted.add(e);
        analytics.capture("hotkey used", { hotkey: `mod+${shift ? "shift+" : ""}${key}` });
      }
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, enabled, analytics, shift]);
}

/**
 * Whether a pane should stay as it is for now: a menu, popover or dialog is open over the window
 * (overlayOpen: a workspace menu anchored in the sidebar would float over nothing, a settings
 * sheet would hide the change), or a field in the pane that holds it (`data-holds-pane`: a
 * design's name being edited on its row) has focus. ⌘B, ⌘J and the menu's commands check it
 * before they toggle.
 */
export function paneHeld(pane: "sidebar" | "thread"): boolean {
  if (typeof document === "undefined") return false;
  if (overlayOpen()) return true;
  return !!document.activeElement?.closest(`#${pane} [data-holds-pane]`);
}

/**
 * Whether the shortcut on `key` just ran. The desktop's menu carries the same accelerators; the
 * page takes the key first and the shell's menu only what it leaves, but a menu command that
 * toggles something checks this, so one press can never toggle it twice.
 */
export function ranJustNow(key: string, ms = 250): boolean {
  const at = ran.get(key);
  return at !== undefined && performance.now() - at < ms;
}

/*
 * The number shortcuts: ⌘1–9 open the sidebar's designs and ⌘0 the create page, as the 1.x
 * studio had them; ⌃1–9 open the open design's pages (1.x used ⌥, which types symbols on a
 * Mac). Off the Mac, Ctrl stands for ⌘ and Alt for ⌃. 9 is always the last, however many there
 * are. Holding the modifier a moment shows each target's number (ShortcutHint).
 */

const mac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** How long the modifier is held before the numbers show, as in 1.x: ⌘K never flashes them. */
export const HINT_DELAY = 250;

/** ⌘ jumps between designs; ⌃ between pages. */
export type Jump = "design" | "page";

/** The key each jump goes with, as its hints write it and as KeyboardEvent.key names it. */
export const JUMP_KEY = {
  design: { glyph: mac ? "⌘" : "Ctrl", key: mac ? "Meta" : "Control" },
  page: { glyph: mac ? "⌃" : "Alt", key: mac ? "Control" : "Alt" },
} as const;

type KeyLike = Pick<
  KeyboardEvent,
  "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing"
>;

/**
 * The digit a key press jumps to, or null. By `code`, since a modifier can change `key`. On a
 * Mac ⌘ takes 0–9 for designs and ⌃ takes 1–9 for pages; off it Ctrl takes the designs and Alt
 * the pages. Nothing with ⇧, or with another modifier as well, so ⌘⌥1 and ⌘⇧1 stay free.
 */
export function jumpDigit(e: KeyLike, jump: Jump, onMac = mac): number | null {
  if (e.shiftKey || e.isComposing) return null;
  const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
  if (!digit) return null;
  const only = (key: "metaKey" | "ctrlKey" | "altKey") =>
    e[key] && (["metaKey", "ctrlKey", "altKey"] as const).every((k) => k === key || !e[k]);
  if (jump === "design") return only(onMac ? "metaKey" : "ctrlKey") ? Number(digit) : null;
  return only(onMac ? "ctrlKey" : "altKey") && digit !== "0" ? Number(digit) : null;
}

/** What `n` (1–9) jumps to: the nth, and 9 the last. */
export function jumpTarget<T>(items: readonly T[], n: number): T | undefined {
  if (n < 1 || n > 9) return undefined;
  return n === 9 ? items.at(-1) : items[n - 1];
}

/** The number item `i` of `count` shows while the modifier is held: 1–8, then 9 on the last. */
export function jumpNumber(i: number, count: number): number | undefined {
  return i < 8 ? i + 1 : i === count - 1 ? 9 : undefined;
}

/**
 * Something is open over the window that a number shouldn't reach past: a menu, a popover, a
 * dialog, a list box. Radix marks each open one with its role and `data-state="open"`.
 */
export function overlayOpen(root: ParentNode = document): boolean {
  return (
    root.querySelector(
      '[data-state="open"]:is([role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"])',
    ) !== null
  );
}

/**
 * Runs `onJump` with the digit of each number shortcut (as `jump` says) and returns whether
 * the modifier's hints should show. Nothing happens while a menu, popover or dialog is open.
 * ⌘ and ⌃ type nothing, so they jump from the composer too, but show no hints there; off the
 * Mac, Alt does nothing while a field has focus, where it can type. `onJump` returns false
 * when the digit has nothing to open, so the key goes on to whatever else wants it.
 */
export function useJumpShortcuts(
  jump: Jump,
  onJump: (n: number) => boolean,
  enabled = true,
): boolean {
  const latest = useRef(onJump);
  latest.current = onJump;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const n = jumpDigit(e, jump);
      if (n === null || e.defaultPrevented) return;
      if (JUMP_KEY[jump].key === "Alt" && isTyping(e)) return;
      if (overlayOpen()) return;
      if (latest.current(n)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [jump, enabled]);
  const shown = useModifierHint(JUMP_KEY[jump].key, HINT_DELAY, () => !overlayOpen());
  return enabled && shown;
}
