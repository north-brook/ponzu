import { APP_NAMES, APP_SCHEMES } from "@ponzu/core/handoff";

/*
 * The app link a canvas's page hands over: `ponzu://canvas/<id>`, or with `?app=ponzu-dev`,
 * Ponzu Dev's (`ponzu-dev://`), for someone running the cloud app beside Ponzu 1.x, whose
 * `ponzu://` links open 1.x. `ponzu-preview` is kept for Ponzu Preview, Ponzu Dev's earlier name,
 * while copies of it are still installed. `app` comes from whoever wrote the link, so only the
 * apps' own schemes (@ponzu/core/handoff, the list the API's pages use too) can come out;
 * anything else is Ponzu's. A `page` or `artboard` (the agent's links to one board) rides along
 * when it could be an id, so the app opens on it; one that couldn't is left behind.
 */

/** A canvas's id, as the apps' `<scheme>://canvas/<id>` takes it. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

type Param = string | string[] | undefined;

export function canvasAppLink(
  id: string,
  app?: Param,
  at: { page?: Param; artboard?: Param } = {},
): string | null {
  if (!ID.test(id)) return null;
  const scheme = APP_SCHEMES.find((known) => known === app) ?? "ponzu";
  const query = new URLSearchParams();
  for (const name of ["page", "artboard"] as const) {
    const value = at[name];
    if (typeof value === "string" && ID.test(value)) query.set(name, value);
  }
  const on = query.size ? `?${query}` : "";
  return `${scheme}://canvas/${id}${on}`;
}

/**
 * The app a link opens, by its scheme, and whether it is the release. Only Ponzu is offered as a
 * download: someone sent a Ponzu Dev link has Ponzu Dev already or can't get it from the site.
 */
export function appOf(link: string | null): { name: string; release: boolean } {
  const scheme = APP_SCHEMES.find((known) => link?.startsWith(`${known}://`)) ?? "ponzu";
  return { name: APP_NAMES[scheme], release: scheme === "ponzu" };
}
