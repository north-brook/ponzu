/*
 * Focus that shows no ring until the keyboard is used. `focus-ring` (cloud.css) skips
 * `[data-quiet-focus]`; the mark goes at the element's first key, or when focus leaves it.
 */

/**
 * A key that moves or works the keyboard's focus: not a modifier alone, nor a shortcut (⌘J,
 * ⌘B and the rest act on the window, not on what has focus).
 */
function keyboards(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return !["Shift", "Meta", "Control", "Alt", "CapsLock", "Fn"].includes(e.key);
}

/** Marks `el` quiet until its first key or its blur. */
function hush(el: HTMLElement): void {
  if ("quietFocus" in el.dataset) return;
  el.dataset.quietFocus = "";
  const done = (e?: Event) => {
    if (e instanceof KeyboardEvent && !keyboards(e)) return;
    delete el.dataset.quietFocus;
    el.removeEventListener("keydown", done, true);
    el.removeEventListener("blur", done);
  };
  el.addEventListener("keydown", done, true);
  el.addEventListener("blur", done);
}

/**
 * Focus `el` without its ring: the keyboard is there for whoever reaches for it, but nothing on
 * screen claims attention the person didn't ask for: a question taking the composer's place, or
 * a menu closing after a click. The ring shows from their first key on it.
 */
export function quietFocus(el: HTMLElement): void {
  hush(el);
  el.focus({ preventScroll: true });
}

let installed = false;

/**
 * Whatever takes focus while the pointer was the last thing used is quiet: the control a click
 * pressed, and anything a click hands focus to (a pane toggle re-rendering, a tip, a popup
 * giving focus back). Chromium shows `:focus-visible` after a click in more cases than the
 * keyboard (an Escape or Shift pressed first, the window coming back to the front, focus moved
 * by script), and a ring after a click reads as a stuck button. From the next key on, focus is
 * the keyboard's and rings again. Installed once, by the app and the gallery.
 */
export function quietPointerFocus(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  let pointer = false;
  const options = { capture: true, passive: true } as const;
  document.addEventListener("pointerdown", () => (pointer = true), options);
  document.addEventListener(
    "keydown",
    (e) => {
      if (keyboards(e)) pointer = false;
    },
    options,
  );
  document.addEventListener(
    "focusin",
    (e) => {
      if (pointer && e.target instanceof HTMLElement) hush(e.target);
    },
    options,
  );
}
