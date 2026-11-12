import { APP_SCHEMES, type AppScheme } from "@ponzu/core/handoff";

/*
 * The apps a page of the API's hands a person back to, by the scheme of the links each takes:
 * Ponzu (`ponzu`, the Mac app and the iPhone) and Ponzu Dev (`ponzu-dev`, the cloud app beside
 * Ponzu 1.x). `ponzu-preview` is Ponzu Dev under its earlier name, Ponzu Preview, kept for the
 * copies of it still installed until they are gone.
 *
 * An app says which it is when it asks for the install link, and that is kept in the install's
 * state, a row only the sealed state names: nothing a browser brings can change where the page
 * links. Besides a scheme an app can say `none`: a build that takes no links (Ponzu Local, run
 * from a checkout, which on a Mac lives inside the generic Electron.app). It learns of the
 * install by asking the API (`GET /v1/github/installs/:id`), so its page links nowhere and says
 * the app has it.
 *
 * Anything else, an app that said nothing or a return with no state at all, is not known, and
 * the page links nowhere: a guess could open an app the person doesn't have, or the release
 * from an environment that serves the development builds.
 */

export const LINK_SCHEMES = APP_SCHEMES;
export type LinkScheme = AppScheme;

/** What an app said of its links when it asked: a scheme, or that it takes none. */
export const LINK_TARGETS = [...LINK_SCHEMES, "none"] as const;
export type LinkTarget = (typeof LINK_TARGETS)[number];

/** `value` when it is one of the schemes or `none`; null, not known, for anything else. */
export function linkTargetOf(value: unknown): LinkTarget | null {
  return LINK_TARGETS.find((target) => target === value) ?? null;
}
