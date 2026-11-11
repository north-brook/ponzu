/*
 * Focus that shows no ring until the keyboard moves it. `focus-ring` (cloud.css) skips
 * `[data-quiet-focus]`; the mark goes at the first key that moves focus, or when focus leaves.
 */

/** Widgets whose arrow keys move focus between their items. */
const COMPOSITE =
  "[role=menu], [role=menubar], [role=tablist], [role=radiogroup], [role=listbox], [role=tree], [role=grid], [role=toolbar]";

/** What Return and Space press: a control, not a field. */
const PRESSABLE =
  "button, a[href], summary, [role=button], [role=link], [role^=menuitem], [role=option], [role=tab], [role=radio], [role=checkbox], [role=switch]";

/**
 * A key that works the keyboard's focus: Tab either way; the arrows, Home and End inside a
 * widget that moves focus with them (a menu, the page tabs, a question's options); and Return
 * or Space on the control that has focus, which presses it. Nothing else: a letter or Escape
 * pressed after a click is meant for the canvas or the window (a tool, deselecting), not for
 * the control the click happened to land on; nor is a shortcut (⌘J, ⌘B) or a modifier alone.
 * (The chrome's controls keep no focus from a click, so Space there pans the canvas.)
 */
function movesFocus(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key === "Tab") return true;
  if (!(e.target instanceof Element)) return false;
  if (e.key === "Enter" || e.key === " ") return e.target.matches(PRESSABLE);
  if (!/^(Arrow(Up|Down|Left|Right)|Home|End)$/.test(e.key)) return false;
  return e.target.closest(COMPOSITE) !== null;
}

/** Marks `el` quiet until a key moves focus from it, or it loses focus. */
function hush(el: HTMLElement): void {
  if ("quietFocus" in el.dataset) return;
  el.dataset.quietFocus = "";
  const done = (e?: Event) => {
    if (e instanceof KeyboardEvent && !movesFocus(e)) return;
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
 * a menu closing after a click. The ring shows once they move focus with the keyboard.
 */
export function quietFocus(el: HTMLElement): void {
  hush(el);
  el.focus({ preventScroll: true });
}

/**
 * The buttons of a toolbar (`data-toolbar`: the window's chrome) that a click doesn't focus. A
 * tab that focuses itself on its press (Radix's) holds its own press back (the page tabs).
 */
const TOOLBAR_PRESS = "[data-toolbar] button:not([aria-haspopup]):not(:disabled)";

let installed = false;

/**
 * Whatever takes focus while the pointer was the last thing used is quiet: the control a click
 * pressed, and anything a click hands focus to (a pane toggle re-rendering, a tip, a popup
 * giving focus back). Chromium shows `:focus-visible` after a click in more cases than the
 * keyboard (any key pressed next, the window coming back to the front, focus moved by script),
 * and a ring after a click reads as a stuck button. Once a key moves focus (movesFocus), focus
 * is the keyboard's and rings again.
 *
 * And a toolbar's buttons and tabs take no focus from a click at all, as a Mac's toolbar
 * buttons don't: focus stays where it was (the composer, the canvas), so the next key goes
 * there and Space can't press the toggle again. Tab still reaches them. A menu or popover's
 * trigger (aria-haspopup) keeps its own focus handling. Installed once, by the app and the
 * gallery.
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
      if (movesFocus(e)) pointer = false;
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
  // On the document as the press bubbles out, after React's handlers (a tab selects on its
  // press, and wouldn't if the press were stopped first): only the focus is held back.
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    if (e.target.closest(TOOLBAR_PRESS)) e.preventDefault();
  });
}
