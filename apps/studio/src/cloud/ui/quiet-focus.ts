/**
 * Focus `el` without its ring (`focus-ring` skips `[data-quiet-focus]`): the keyboard is there
 * for whoever reaches for it, but nothing on screen claims attention the person didn't ask for:
 * a question taking the composer's place, or a menu closing after a click. The ring shows from
 * their first key on it, and the mark goes when focus leaves.
 */
export function quietFocus(el: HTMLElement): void {
  el.dataset.quietFocus = "";
  const done = () => {
    delete el.dataset.quietFocus;
    el.removeEventListener("keydown", done, true);
    el.removeEventListener("blur", done);
  };
  el.addEventListener("keydown", done, true);
  el.addEventListener("blur", done);
  el.focus({ preventScroll: true });
}
