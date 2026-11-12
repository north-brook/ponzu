import { isTyping, useModifierHint } from "@ponzu/canvas/modifier-hint";
import { useEffect, useRef } from "react";
import { useAnalytics } from "../../app/analytics/provider.tsx";

/** Key presses already counted: two shortcuts on one key (⌘, has two) are one use. */
const counted = new WeakSet<KeyboardEvent>();

/** Presses a `once` shortcut has already run for. */
const pressed = new WeakSet<object>();

/** When each shortcut last ran, by key: a menu item with the same accelerator checks it. */
const ran = new Map<string, number>();

/** How a shortcut is pressed, past ⌘ and its key, and when it may run. */
export interface ShortcutOptions {
  /** ⇧ as well (⌘⇧↵); without it, a press with ⇧ is another shortcut's. */
  shift?: boolean;
  /**
   * ⌥ as well (⌥⌘B); without it, a press with ⌥ is another shortcut's. The key is then read
   * from where it sits on the keyboard, since ⌥ with a letter types a symbol on a Mac (⌥B is
   * "∫").
   */
  alt?: boolean;
  /**
   * Whether it may run now, asked at each press: when not, the key is left alone (not taken,
   * not counted), as if the shortcut weren't there.
   */
  when?: () => boolean;
  /**
   * One press runs it once: not again with each repeat of a key held down, and not a second
   * time for another of the same shortcut mounted at once. For what can't be undone.
   */
  once?: boolean;
}

type Press = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing" | "repeat"
>;

/** The key a press is by its place on the keyboard: "KeyB" is "b", "Digit1" is "1". */
const placed = (e: Press) =>
  /^Key[A-Z]$/.test(e.code) || /^Digit[0-9]$/.test(e.code) ? e.code.slice(-1).toLowerCase() : null;

/**
 * What a key press is to the shortcut on ⌘ (Ctrl off the Mac) plus `key`: not its own (null:
 * another key, other modifiers, mid-composition, or `when` says not now); its own but already
 * run ("taken": a repeat, or another of it ran for this press, when it is `once`); or to run.
 * `seen` holds the presses a `once` shortcut has run for.
 */
export function shortcutPress(
  e: Press,
  key: string,
  { shift = false, alt = false, when, once = false }: ShortcutOptions = {},
  seen: WeakSet<object> = pressed,
): "run" | "taken" | null {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey !== shift || e.altKey !== alt) return null;
  const pressedKey = (alt ? placed(e) : null) ?? e.key.toLowerCase();
  if (pressedKey !== key || e.isComposing) return null;
  if (when && !when()) return null;
  if (!once) return "run";
  if (e.repeat || seen.has(e)) return "taken";
  seen.add(e);
  return "run";
}

/** A shortcut as `hotkey used` names it: "mod+p", "mod+shift+enter", "mod+alt+b". */
export const hotkeyName = (key: string, shift = false, alt = false) =>
  `mod+${alt ? "alt+" : ""}${shift ? "shift+" : ""}${key}`;

/** A shortcut as `ranJustNow` knows it: its key, with "alt+" before it when ⌥ is part of it. */
const ranName = (key: string, alt: boolean) => (alt ? `alt+${key}` : key);

/**
 * Runs `handler` on ⌘ (Ctrl off the Mac) plus `key`, anywhere in the window, text fields
 * included: none of the app's take rich text, so no shortcut here shadows one of theirs. `key`
 * is the KeyboardEvent key, lowercase: "k", "n", "b", ",", "p", "enter". Each use is
 * counted (`hotkey used`, hotkeyName), and a press it takes does nothing else in the page.
 */
export function useShortcut(
  key: string,
  handler: () => void,
  enabled = true,
  { shift = false, alt = false, when, once = false }: ShortcutOptions = {},
): void {
  const latest = useRef({ handler, when });
  latest.current = { handler, when };
  const analytics = useAnalytics();
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const press = shortcutPress(e, key, { shift, alt, once, when: latest.current.when });
      if (!press) return;
      e.preventDefault();
      if (press === "taken") return;
      ran.set(ranName(key, alt), performance.now());
      if (!counted.has(e)) {
        counted.add(e);
        analytics.capture("hotkey used", { hotkey: hotkeyName(key, shift, alt) });
      }
      latest.current.handler();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, enabled, analytics, shift, alt, once]);
}

/**
 * Whether a pane should stay as it is for now: a menu, popover or dialog is open over the window
 * (overlayOpen: a workspace menu anchored in the sidebar would float over nothing, a settings
 * sheet would hide the change), or a field in the pane that holds it (`data-holds-pane`: a
 * canvas's name being edited on its row) has focus. ⌘B, ⌥⌘B and the menu's commands check it
 * before they toggle.
 */
export function paneHeld(pane: "sidebar" | "thread"): boolean {
  if (typeof document === "undefined") return false;
  if (overlayOpen()) return true;
  return !!document.activeElement?.closest(`#${pane} [data-holds-pane]`);
}

/**
 * Whether the shortcut on `key` just ran (`"alt+b"` for one with ⌥). The desktop's menu carries the same accelerators; the
 * page takes the key first and the shell's menu only what it leaves, but a menu command that
 * toggles something checks this, so one press can never toggle it twice.
 */
export function ranJustNow(key: string, ms = 250): boolean {
  const at = ran.get(key);
  return at !== undefined && performance.now() - at < ms;
}

/*
 * The number shortcuts: ⌘1–9 open the sidebar's canvases and ⌘0 the create page, as the 1.x
 * studio had them; ⌃1–9 open the open canvas's pages (1.x used ⌥, which types symbols on a
 * Mac). Off the Mac, Ctrl stands for ⌘ and Alt for ⌃. 9 is always the last, however many there
 * are. Holding the modifier a moment shows each target's number (ShortcutHint).
 */

const mac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** How long the modifier is held before the numbers show, as in 1.x: ⌘K never flashes them. */
export const HINT_DELAY = 250;

/** ⌘ jumps between canvases; ⌃ between pages. */
export type Jump = "canvas" | "page";

/** The key each jump goes with, as its hints write it and as KeyboardEvent.key names it. */
export const JUMP_KEY = {
  canvas: { glyph: mac ? "⌘" : "Ctrl", key: mac ? "Meta" : "Control" },
  page: { glyph: mac ? "⌃" : "Alt", key: mac ? "Control" : "Alt" },
} as const;

type KeyLike = Pick<
  KeyboardEvent,
  "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing"
>;

/**
 * The digit a key press jumps to, or null. By `code`, since a modifier can change `key`. On a
 * Mac ⌘ takes 0–9 for canvases and ⌃ takes 1–9 for pages; off it Ctrl takes the canvases and Alt
 * the pages. Nothing with ⇧, or with another modifier as well, so ⌘⌥1 and ⌘⇧1 stay free.
 */
export function jumpDigit(e: KeyLike, jump: Jump, onMac = mac): number | null {
  if (e.shiftKey || e.isComposing) return null;
  const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
  if (!digit) return null;
  const only = (key: "metaKey" | "ctrlKey" | "altKey") =>
    e[key] && (["metaKey", "ctrlKey", "altKey"] as const).every((k) => k === key || !e[k]);
  if (jump === "canvas") return only(onMac ? "metaKey" : "ctrlKey") ? Number(digit) : null;
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
