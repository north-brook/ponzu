import type { MouseEvent } from "react";

/**
 * What a press on a field's card leaves alone: the controls in it (attach, send, a picker, an
 * image's remove), and the field itself, whose own press places the caret and starts a selection.
 */
const OWN_PRESS =
  "button, a[href], input, textarea, select, label, summary, [contenteditable], [role=button], [role=link], [role=menuitem], [role=option], [role=radio], [role=checkbox], [role=switch], [role=tab], [role=slider], [tabindex]:not([tabindex='-1'])";

/** Marks the field a card's presses focus (pressToFocus). */
export const FIELD = { "data-press-focus": "" } as const;

/**
 * A composer is one card around its field: a press anywhere on it that isn't a control goes to
 * the field, with the caret at the end, as if the card were the field. Pass it as the card's
 * `onMouseDown`, give the card `cursor-text`, and spread FIELD on the field.
 *
 * It acts on the press, not the click, so a selection dragged out of the field and let go over
 * the card is left as it is; and it keeps the press from doing anything else (blurring the
 * field, starting a selection of the card's own words). A field already focused keeps its caret
 * and selection. Only the mouse: the keyboard and a screen reader reach the field as before.
 */
export function pressToFocus(e: MouseEvent<HTMLElement>) {
  if (e.button !== 0 || e.defaultPrevented) return;
  const target = e.target as Element;
  const control = target.closest(OWN_PRESS);
  if (control && e.currentTarget.contains(control)) return;
  const field = e.currentTarget.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    "[data-press-focus]",
  );
  if (!field || field.disabled || !field.getClientRects().length) return;
  e.preventDefault();
  if (document.activeElement === field) return;
  field.focus({ preventScroll: true });
  const end = field.value.length;
  // A password field has no caret to place.
  try {
    field.setSelectionRange(end, end);
  } catch {}
}
