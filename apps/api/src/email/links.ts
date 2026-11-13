import type { NotificationLink } from "@ponzu/db";
import { SITE_URL } from "@ponzu/email";
import type { Environment } from "../env.ts";

/*
 * Where an email's links go (docs/cloud.md, "Email"): always to a handoff page on the site
 * (https://ponzu.design), never to `ponzu://` directly, so a link works in any mail app and on a
 * computer without Ponzu. The page opens the app with the same ids.
 *
 * From any environment but production, a link also says `app=ponzu-dev`, so the page opens the
 * development app, which talks to that environment's API.
 */

/** The app a link from this environment opens on the site's handoff page, when not Ponzu. */
function withApp(url: URL, environment: Environment): string {
  if (environment !== "production") url.searchParams.set("app", "ponzu-dev");
  return url.toString();
}

/** A canvas, with what to open there riding along: `/canvases/<id>?open=&page=…`. */
export function canvasHref(
  environment: Environment,
  canvasId: string,
  link: NotificationLink,
): string {
  const url = new URL(`/canvases/${encodeURIComponent(canvasId)}`, SITE_URL);
  url.searchParams.set("open", link.open);
  if (link.pageId) url.searchParams.set("page", link.pageId);
  if (link.artboardId) url.searchParams.set("artboard", link.artboardId);
  if (link.questionId) url.searchParams.set("question", link.questionId);
  if (link.commentThreadId) url.searchParams.set("comment", link.commentThreadId);
  return withApp(url, environment);
}

/** The sections of Settings a link can open, as `@ponzu/core/links` names them. */
export type SettingsSection = "usage" | "notifications" | "account";

/**
 * A section of Settings: `/settings?section=usage&workspace=<id>&n=<notification id>`, where
 * `n` lets the app mark that notification read once it opens.
 */
export function settingsHref(
  environment: Environment,
  {
    section,
    workspaceId,
    notificationId,
  }: { section: SettingsSection; workspaceId?: string | null; notificationId?: string | null },
): string {
  const url = new URL("/settings", SITE_URL);
  url.searchParams.set("section", section);
  if (workspaceId) url.searchParams.set("workspace", workspaceId);
  if (notificationId) url.searchParams.set("n", notificationId);
  return withApp(url, environment);
}
