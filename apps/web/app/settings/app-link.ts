import { appLink, LINK_ID, LINK_SCHEMES, SETTINGS_SECTIONS } from "@ponzu/core/links";

/*
 * The app link the settings page hands over: `ponzu://settings?section=&workspace=&n=`, the link
 * grammar's settings link (@ponzu/core/links), which Ponzu's emails reach through
 * https://ponzu.design/settings, since a mail app may not open an app's own scheme. `section` is
 * one of the grammar's sections (usage, notifications, account), `workspace` the workspace the
 * section is about (a billing email's), and `n` the notification the email came from, so opening
 * it can mark it read. Every part comes from whoever wrote the link, so each is kept only when it
 * is exactly one the grammar takes, and anything else is dropped rather than trusted; the link
 * itself is written by `appLink`, never by hand.
 *
 * `?app=ponzu-dev` hands it to Ponzu Dev, as development's emails ask. Only the schemes the
 * grammar answers (`ponzu`, `ponzu-dev`) can come out. Unlike a canvas's page, `ponzu-preview` is
 * not one: a Ponzu Preview built before the rename never knew settings links, so like anything
 * else unknown it falls back to Ponzu.
 */

type Param = string | string[] | undefined;

export function settingsAppLink(
  app?: Param,
  at: { section?: Param; workspace?: Param; n?: Param } = {},
): string {
  const scheme = LINK_SCHEMES.find((known) => known === app) ?? "ponzu";
  const section = SETTINGS_SECTIONS.find((known) => known === at.section);
  const id = (value: Param) =>
    typeof value === "string" && LINK_ID.test(value) ? value : undefined;
  const workspaceId = id(at.workspace);
  const notificationId = id(at.n);
  return appLink(
    {
      kind: "settings",
      ...(section ? { section } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(notificationId ? { notificationId } : {}),
    },
    scheme,
  );
}
