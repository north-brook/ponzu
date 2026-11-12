/*
 * The focus ring is the keyboard's navigation, and nothing else's. `focus-ring` (cloud.css), and
 * the canvas package's controls, draw on `:focus-visible` but skip `[data-quiet-focus]`, and
 * everything that takes focus is marked quiet unless keyboard navigation put it there: Tab or
 * Shift-Tab, or an arrow, Home or End moving focus inside a menu, a list, the page tabs, the
 * people in the chrome; and Return or Space on a control so reached, handing focus on to the
 * popover or dialog it opens (presses). Focus from a click, from a shortcut acting through a control, or from
 * our own code handing it on (a question taking the composer's place, a surface closing) is
 * quiet for as long as it stays, however many keys are pressed after it: holding ⌘ for ⌘K, or ⌥
 * for a page's number, never lights the control last touched.
 *
 * Why our own: Chromium's `:focus-visible` turns on for a clicked button as soon as any key is
 * pressed, a modifier alone included, and for anything focused by script after a key; Radix
 * exposes no modality, and react-aria's (useFocusVisible) counts any key but a lone modifier as
 * the keyboard's, so a shortcut lights it the same way. What it takes is one capture listener on
 * keydown, one on focusin and one on pointerdown.
 */

/** Widgets whose arrow keys move focus between their items, where an arrow is navigation. */
const COMPOSITE =
  "[role=menu], [role=menubar], [role=tablist], [role=radiogroup], [role=listbox], [role=tree], [role=grid], [role=toolbar], [role=group], ul, ol";

/** The keys that navigate: Tab either way, and the arrows, Home and End. */
function navigates(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return /^(Tab|Arrow(Up|Down|Left|Right)|Home|End)$/.test(e.key);
}

/** A key on a field types or moves its caret: it doesn't navigate in place. */
function isField(el: Element): boolean {
  return el.matches("input, textarea, select, [contenteditable]:not([contenteditable=false])");
}

/** Keyboard navigation is under way: a navigating key is down, so focus that arrives is its. */
let navigating = false;
/**
 * What keyboard navigation has reached since the pointer was last used: focus given back to one
 * of these (a menu or a dialog closing onto the control that opened it) shows its ring again.
 */
let reached = new WeakSet<Element>();

function unhush(el: HTMLElement): void {
  delete el.dataset.quietFocus;
}

/** Marks `el` quiet until it loses focus, or a key navigates in place on it. */
function hush(el: HTMLElement): void {
  if ("quietFocus" in el.dataset) return;
  el.dataset.quietFocus = "";
  const done = (e: Event) => {
    if (e instanceof KeyboardEvent) {
      // An arrow at the end of a list, or Tab on the last thing in a dialog, moves no focus,
      // but the person is navigating from here: it's theirs now.
      if (!navigates(e) || isField(el)) return;
      if (e.key !== "Tab" && el.closest(COMPOSITE) === null) return;
      reached.add(el);
    }
    unhush(el);
    el.removeEventListener("keydown", done, true);
    el.removeEventListener("blur", done);
  };
  el.addEventListener("keydown", done, true);
  el.addEventListener("blur", done);
}

/**
 * Focus `el` without its ring: the keyboard is there for whoever reaches for it, but nothing on
 * screen claims attention the person didn't ask for: a question taking the composer's place, or
 * a menu closing after a click. The ring shows once they navigate from it.
 */
export function quietFocus(el: HTMLElement): void {
  hush(el);
  el.focus({ preventScroll: true });
}

/**
 * Focus `el` as keyboard navigation would, ring and all: where a surface gives focus back to a
 * control the keyboard had reached but that has since been drawn again (a new element).
 */
export function keyboardFocus(el: HTMLElement): void {
  reached.add(el);
  unhush(el);
  el.focus({ preventScroll: true });
}

/** Whether `el` has focus that keyboard navigation gave it: its ring is showing. */
export function hasKeyboardFocus(el: Element | null): boolean {
  return (
    !!el && el === document.activeElement && reached.has(el) && !el.matches("[data-quiet-focus]")
  );
}

/**
 * Where focus is now, to give it back to when something that took it closes: the element, and
 * whether it was the keyboard's. Nothing when focus is on the page itself.
 */
export function focusNow(): { el: HTMLElement; keyboard: boolean } | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return null;
  return { el, keyboard: hasKeyboardFocus(el) };
}

/**
 * Gives focus back as `focusNow` found it: to the same element, or to `redrawn` if that one has
 * left the page (the control it was on, drawn again). Found nowhere, it stays nowhere: the next
 * key goes to the window, as before.
 */
export function giveFocusBack(
  was: { el: HTMLElement; keyboard: boolean } | null,
  redrawn: HTMLElement | null,
): void {
  if (!was) return;
  const el = was.el.isConnected ? was.el : redrawn;
  if (!el) return;
  if (was.keyboard) keyboardFocus(el);
  else quietFocus(el);
}

/**
 * The buttons of a toolbar (`data-toolbar`: the window's chrome, the sidebar's header) that a
 * click doesn't focus. A tab that focuses itself on its press (Radix's) holds its own press back
 * (the page tabs).
 */
const TOOLBAR_PRESS = "[data-toolbar] button:not([aria-haspopup]):not(:disabled)";

/** What Return and Space press: a control, not a field. */
const PRESSABLE =
  "button, a[href], summary, [role=button], [role=link], [role^=menuitem], [role=option], [role=tab], [role=radio], [role=checkbox], [role=switch]";

/**
 * Return or Space on a control that has the keyboard's focus, its ring showing: the press is the
 * keyboard's too, so focus it hands on (a popover or dialog opening onto its first control) rings
 * where it lands, as Tab's would. On a control a click or a shortcut focused, it stays quiet.
 */
function presses(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "Enter" && e.key !== " ")) return false;
  return e.target instanceof Element && e.target.matches(PRESSABLE) && hasKeyboardFocus(e.target);
}

/** A press is handing focus on (presses): from its key until a moment after it's released. */
let handingOn = false;
let handOff: ReturnType<typeof setTimeout> | undefined;
const HAND_ON_MS = 500;

let installed = false;

/**
 * Installs the rule, once, for the app and the gallery: focus that arrives while a navigating
 * key is down is the keyboard's; any other is quiet (hush), unless it comes back to something
 * the keyboard had reached (a menu or a dialog closing onto its trigger) since the pointer was
 * last used.
 *
 * And a toolbar's buttons and tabs take no focus from a click at all, as a Mac's toolbar
 * buttons don't: focus stays where it was (the composer, the canvas), so the next key goes
 * there and Space can't press the toggle again. Tab still reaches them. A menu or popover's
 * trigger (aria-haspopup) keeps its own focus handling.
 */
export function installFocusRule(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const options = { capture: true, passive: true } as const;
  document.addEventListener(
    "pointerdown",
    () => {
      navigating = false;
      handingOn = false;
      reached = new WeakSet();
    },
    options,
  );
  // Tab moves focus after its keydown, Radix's roving focus during it: both land while the key is
  // down. Any other key ends it.
  document.addEventListener(
    "keydown",
    (e) => {
      navigating = navigates(e);
      handingOn = presses(e);
      clearTimeout(handOff);
    },
    options,
  );
  document.addEventListener(
    "keyup",
    (e) => {
      navigating = false;
      // Space presses on its release, Return on its press; whatever the press opens takes focus
      // a moment after (a popover's first control, a dialog's field), and then it's over.
      if (handingOn && (e.key === "Enter" || e.key === " ")) {
        clearTimeout(handOff);
        handOff = setTimeout(() => (handingOn = false), HAND_ON_MS);
      }
    },
    options,
  );
  window.addEventListener("blur", () => {
    navigating = false;
    handingOn = false;
  });
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      // Handed on by a press, unless our own code asked for it quiet (quietFocus marks first).
      if (navigating || (handingOn && !("quietFocus" in el.dataset))) {
        reached.add(el);
        unhush(el);
      } else if (!reached.has(el)) {
        hush(el);
      }
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
