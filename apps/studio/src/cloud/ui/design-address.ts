/*
 * A design's own address, as the agent writes it in the thread to point at a page or a board:
 *
 *   https://ponzu.design/designs/<design id>                  the design
 *   https://ponzu.design/designs/<design id>?page=<page id>   one of its pages
 *   https://ponzu.design/designs/<design id>?artboard=<id>    one of its boards
 *
 * It is the address the API gives the agent (and a pull request's description), a real page of
 * ponzu.design that hands the same place to the app as `ponzu://design/<id>?…`, so a link means
 * the same in the thread, on GitHub, in a notification or pasted anywhere. The thread follows one
 * in place instead of leaving the app. Text is untrusted, so this reads the address exactly: the
 * host itself over https (no port, no user, no lookalike), the one path, ids as ids. Anything
 * else is an ordinary link and goes where an ordinary link goes; nothing here widens what
 * markdown.ts lets through, since only an address that already passed `safeHref` reaches it.
 */

/** Ids as the app's ponzu:// links take them (apps/desktop/src/deep-links.ts). */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PATH = /^\/designs\/([A-Za-z0-9_-]{1,64})\/?$/;

/** The place an address names: a design, and maybe one page or board of it. */
export interface DesignAddress {
  designId: string;
  page?: string;
  artboard?: string;
}

export function parseDesignAddress(href: string): DesignAddress | null {
  if (!URL.canParse(href)) return null;
  const url = new URL(href);
  if (url.protocol !== "https:" || url.hostname !== "ponzu.design") return null;
  if (url.port || url.username || url.password) return null;
  const designId = PATH.exec(url.pathname)?.[1];
  if (!designId) return null;
  const at: DesignAddress = { designId };
  for (const name of ["page", "artboard"] as const) {
    const values = url.searchParams.getAll(name);
    if (!values.length) continue;
    // A place that isn't an id, or two of one, isn't ours to guess at.
    if (values.length > 1 || !ID.test(values[0]!)) return null;
    at[name] = values[0]!;
  }
  return at;
}
