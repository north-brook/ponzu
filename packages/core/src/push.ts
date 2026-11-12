/*
 * A ping's `data`: what the API puts beside a push's words, and all a tap has to go on. Version 1
 * is ids only, so nothing anyone wrote crosses Expo or Apple, and it stays far under Expo's 4 KB
 * for a whole message (the API's payload builder checks the message itself).
 *
 *   { v: 1, n: <notification id>, k: <kind>, c?: <canvas>, w?: <workspace>, o: <open>,
 *     p?: <page>, a?: <artboard>, t?: <comment thread>, q?: <question> }
 *
 * `o` is what the tap opens, in the link grammar's words (links.ts): the canvas's thread, its
 * pull request, a comment, or Plan and usage. Every `o` but `usage` names its canvas. A tap goes
 * where `linkOfPush` says, through the same grammar as every other link into the apps.
 *
 * `k` is the notification's kind. It only rides along for the client's own use (grouping,
 * analytics); a kind this build doesn't know still opens, so a newer API can add kinds.
 */
import { z } from "zod";
import { type AppLink, CANVAS_OPENS, type CanvasLink, LINK_ID } from "./links.ts";

const id = z.string().regex(LINK_ID);

export const pushData = z
  .object({
    v: z.literal(1),
    n: id,
    k: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    c: id.optional(),
    w: id.optional(),
    o: z.enum(CANVAS_OPENS),
    p: id.optional(),
    a: id.optional(),
    t: id.optional(),
    q: id.optional(),
  })
  .refine((data) => data.o === "usage" || data.c !== undefined, {
    message: "only usage opens without a canvas",
    path: ["c"],
  });

export type PushData = z.infer<typeof pushData>;

/** `raw` as a version 1 ping's data, or null when it isn't one. */
export function parsePushData(raw: unknown): PushData | null {
  const parsed = pushData.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Where a tap on a ping with `data` goes. */
export function linkOfPush(data: PushData): AppLink {
  if (data.o === "usage") return { kind: "settings", section: "usage" };
  const link: CanvasLink = {
    kind: "canvas",
    canvasId: data.c!,
    open: data.o,
    notificationId: data.n,
  };
  if (data.p) link.pageId = data.p;
  if (data.a) link.artboardId = data.a;
  if (data.t) link.commentThreadId = data.t;
  if (data.q) link.questionId = data.q;
  return link;
}

/**
 * Where a tap goes on whatever a ping carried: its link when it is version 1, else the canvas it
 * names, if any (a newer API's ping on an older app still opens its canvas), else null, which
 * leaves the app where it opens.
 */
export function linkOfPushData(raw: unknown): AppLink | null {
  const data = parsePushData(raw);
  if (data) return linkOfPush(data);
  const canvasId = raw && typeof raw === "object" ? (raw as Record<string, unknown>).c : undefined;
  return typeof canvasId === "string" && LINK_ID.test(canvasId)
    ? { kind: "canvas", canvasId }
    : null;
}
