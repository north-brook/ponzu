import { isTyping, useModifierHint } from "@ponzu/canvas/modifier-hint";
import { useEffect, useRef } from "react";

/**
 * Runs `handler` on ⌘ (Ctrl off the Mac) plus `key`, anywhere in the window. `key` is the
 * KeyboardEvent key, lowercase: "k", "n", "j", ",".
 */
export function useShortcut(key: string, handler: () => void, enabled = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== key) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, enabled]);
}

/*
 * The number shortcuts, as the 1.x studio had them: ⌘1–9 (Ctrl off the Mac) open the sidebar's
 * designs, ⌘0 the create page, ⌥1–9 the open design's pages. 9 is always the last, however many
 * there are. Holding the modifier a moment shows each target's number (ShortcutHint).
 */

const mac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** How long the modifier is held before the numbers show, as in 1.x: ⌘K never flashes them. */
export const HINT_DELAY = 250;

/** ⌘ jumps between designs; ⌥ between pages. */
export type Jump = "design" | "page";

/** The key each jump goes with, as its hints write it and as KeyboardEvent.key names it. */
export const JUMP_KEY = {
  design: { glyph: mac ? "⌘" : "Ctrl", key: mac ? "Meta" : "Control" },
  page: { glyph: mac ? "⌥" : "Alt", key: "Alt" },
} as const;

type KeyLike = Pick<
  KeyboardEvent,
  "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing"
>;

/**
 * The digit a key press jumps to, or null. By `code`, since ⌥ turns `key` into ¡™£ on a Mac.
 * ⌘ takes 0–9 (either ⌘ or Ctrl, as 1.x did); ⌥ takes 1–9. Nothing with ⇧, or with the other
 * modifier as well, so ⌘⌥1 and ⌘⇧1 stay free.
 */
export function jumpDigit(e: KeyLike, jump: Jump): number | null {
  if (e.shiftKey || e.isComposing) return null;
  const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
  if (!digit) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (jump === "design") return mod && !e.altKey ? Number(digit) : null;
  return e.altKey && !mod && digit !== "0" ? Number(digit) : null;
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
 * Runs `onJump` with the digit of each ⌘ or ⌥ number shortcut (as `jump` says) and returns
 * whether the modifier's hints should show. Nothing happens while a menu, popover or dialog is
 * open; ⌥ also does nothing while a field has focus, where it types a symbol (⌘ types nothing,
 * so it jumps from the composer as it did in 1.x, but shows no hints there). `onJump` returns
 * false when the digit has nothing to open, so the key goes on to whatever else wants it.
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
      if (jump === "page" && isTyping(e)) return;
      if (overlayOpen()) return;
      if (latest.current(n)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [jump, enabled]);
  const shown = useModifierHint(JUMP_KEY[jump].key, HINT_DELAY, () => !overlayOpen());
  return enabled && shown;
}
