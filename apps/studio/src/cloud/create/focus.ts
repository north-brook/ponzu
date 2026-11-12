/** What, open over the window, keeps the caret where it is: a menu, a popover, a dialog. */
const OVER = ['[role="menu"]', '[role="dialog"]', '[data-slot="popover-content"]']
  .map((what) => `${what}[data-state="open"]`)
  .join(", ");

/**
 * Puts the caret in the create page's composer once the page that is coming has drawn: after
 * New design, after a workspace is switched to from the sidebar, after a project in another
 * workspace is chosen. Only when the create page is what shows: where the workspace opened on a
 * design there is no composer to find, and nothing happens; nor under a menu, popover or dialog
 * still open, nor while a send is under way (the page's composer is away travelling).
 */
export function focusCreateComposer(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const page = document.querySelector<HTMLElement>("[data-create-composer]");
      if (!page || page.hasAttribute("data-launched") || page.closest("[inert]")) return;
      if (document.querySelector(OVER)) return;
      page.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    }),
  );
}
