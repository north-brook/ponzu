import { useEffect, useRef } from "react";

/** When each shortcut last ran, by key: a menu item with the same accelerator checks it. */
const ran = new Map<string, number>();

/**
 * Runs `handler` on ⌘ (Ctrl off the Mac) plus `key`, anywhere in the window, text fields
 * included: none of the app's take rich text, so no shortcut here shadows one of theirs. `key`
 * is the KeyboardEvent key, lowercase: "k", "n", "j", "b", ",".
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
      ran.set(key, performance.now());
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, enabled]);
}

/** A layer over the window that a pane's toggle must not pull the ground from under. */
const LAYER = "[role=menu], [role=dialog][aria-modal=true], [role=alertdialog]";

/**
 * Whether a pane should stay as it is for now: a menu or a modal is open over the window (a
 * workspace menu anchored in the sidebar would float over nothing, a settings sheet would hide
 * the change), or a field in the pane that holds it (`data-holds-pane`: a design's name being
 * edited on its row) has focus. ⌘B, ⌘J and the menu's commands check it before they toggle.
 */
export function paneHeld(pane: "sidebar" | "thread"): boolean {
  if (typeof document === "undefined") return false;
  if (document.querySelector(LAYER)) return true;
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
