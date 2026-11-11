/*
 * The apps a page of the API's hands a person back to, by the scheme of the links each takes:
 * Ponzu (`ponzu`, the Mac app and the iPhone), Ponzu Preview (`ponzu-preview`, the cloud app
 * beside Ponzu 1.x) and a development build (`ponzu-dev`). An app says which it is when it asks
 * for the install link, and the scheme is kept in the install's state, a row only the sealed
 * state names: nothing a browser brings can change where the page links. Anything else is
 * `ponzu`, never a scheme someone made up.
 */

export const LINK_SCHEMES = ["ponzu", "ponzu-preview", "ponzu-dev"] as const;
export type LinkScheme = (typeof LINK_SCHEMES)[number];

export const DEFAULT_LINK_SCHEME: LinkScheme = "ponzu";

/** `value` when it is one of the schemes, else Ponzu's own. */
export function linkSchemeOf(value: unknown): LinkScheme {
  return LINK_SCHEMES.find((scheme) => scheme === value) ?? DEFAULT_LINK_SCHEME;
}
