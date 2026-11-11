/*
 * The app link a design's page hands over: `ponzu://design/<id>`, or with `?app=` naming Ponzu
 * Preview or a development build, theirs (`ponzu-preview://`, `ponzu-dev://`), for someone running
 * the cloud app beside Ponzu 1.x, whose `ponzu://` links open 1.x. `app` comes from whoever wrote
 * the link, so only these three schemes can come out; anything else is Ponzu's.
 */

/** A design's id, as the apps' `<scheme>://design/<id>` takes it. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const SCHEMES = ["ponzu", "ponzu-preview", "ponzu-dev"] as const;

export function designAppLink(id: string, app?: string | string[]): string | null {
  if (!ID.test(id)) return null;
  const scheme = SCHEMES.find((known) => known === app) ?? "ponzu";
  return `${scheme}://design/${id}`;
}
