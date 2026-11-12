import { describe, expect, test } from "bun:test";
import type { NotificationRow } from "@ponzu/client";
import {
  type BannerContext,
  badgeCount,
  bannerKey,
  FRESH_MS,
  inboxStep,
  isActive,
  LAUNCH_GRACE_MS,
  linkOfRow,
  noticeOfRow,
  shouldBanner,
  timeZoneToSend,
} from "./notify.ts";

const LAUNCH = Date.parse("2026-11-12T09:00:00.000Z");
const at = (ms: number) => new Date(LAUNCH + ms).toISOString();

function row(patch: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "ntf_1",
    kind: "needs_you",
    workspaceId: "ws_1",
    canvasId: "cnv_1",
    title: "Onboarding flow",
    subtitle: null,
    body: "Ponzu has a question for you.",
    link: { open: "thread", questionId: "q_1" },
    count: 1,
    muted: false,
    readAt: null,
    resolvedAt: null,
    createdAt: at(1000),
    updatedAt: at(1000),
    ...patch,
  };
}

const ctx = (patch: Partial<BannerContext> = {}): BannerContext => ({
  launchedAt: LAUNCH,
  now: LAUNCH + 2000,
  shown: new Set(),
  pings: true,
  looking: null,
  ...patch,
});

describe("shouldBanner", () => {
  test("a new, unread, unmuted question shows", () => {
    expect(shouldBanner(row(), ctx())).toBe(true);
  });

  test("muted (its toggle off), read, or its question closed: no banner", () => {
    expect(shouldBanner(row({ muted: true }), ctx())).toBe(false);
    expect(shouldBanner(row({ readAt: at(1500) }), ctx())).toBe(false);
    expect(shouldBanner(row({ resolvedAt: at(1500), updatedAt: at(1500) }), ctx())).toBe(false);
  });

  test("this Mac's pings off: no banner", () => {
    expect(shouldBanner(row(), ctx({ pings: false }))).toBe(false);
  });

  test("looking at its canvas: no banner; at another canvas: one", () => {
    expect(shouldBanner(row(), ctx({ looking: "cnv_1" }))).toBe(false);
    expect(shouldBanner(row(), ctx({ looking: "cnv_2" }))).toBe(true);
  });

  test("shown once this launch, not again", () => {
    const shown = new Set([bannerKey(row())]);
    expect(shouldBanner(row(), ctx({ shown }))).toBe(false);
  });

  test("the launch window: made up to 60 s before the launch shows, older doesn't", () => {
    const edge = row({ createdAt: at(-LAUNCH_GRACE_MS), updatedAt: at(-LAUNCH_GRACE_MS) });
    const older = row({ createdAt: at(-LAUNCH_GRACE_MS - 1), updatedAt: at(0) });
    expect(shouldBanner(edge, ctx())).toBe(true);
    expect(shouldBanner(older, ctx())).toBe(false);
  });

  test("ten minutes old is the last moment a row is news", () => {
    const made = row({ createdAt: at(60_000) });
    expect(shouldBanner(made, ctx({ now: LAUNCH + 60_000 + FRESH_MS }))).toBe(true);
    expect(shouldBanner(made, ctx({ now: LAUNCH + 60_000 + FRESH_MS + 1 }))).toBe(false);
  });

  test("a teammate's comments folding into the row are news again, under the same id", () => {
    const first = row({ kind: "teammate_comment", body: "Sam commented." });
    const shown = new Set([bannerKey(first)]);
    const folded = { ...first, body: "Sam left 2 comments.", count: 2, updatedAt: at(5000) };
    expect(shouldBanner(first, ctx({ shown }))).toBe(false);
    expect(shouldBanner(folded, ctx({ shown, now: LAUNCH + 6000 }))).toBe(true);
    expect(bannerKey(folded)).not.toBe(bannerKey(first));
    // Any other kind is news once, when made: a change to it later is not.
    const touched = row({ updatedAt: at(9000) });
    expect(bannerKey(touched)).toBe(bannerKey(row()));
  });
});

describe("launching with a full inbox", () => {
  test("50 old unread rows show nothing; the badge counts their open questions", () => {
    const old = Array.from({ length: 50 }, (_, i) =>
      row({ id: `ntf_${i}`, createdAt: at(-3_600_000), updatedAt: at(-3_600_000) }),
    );
    const step = inboxStep(old, new Set(), ctx());
    expect(step.show).toEqual([]);
    expect(step.badge).toBe(50);
  });
});

describe("badgeCount", () => {
  test("open needs-you questions, read, muted or not; nothing else", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", readAt: at(2000) }),
      row({ id: "c", muted: true }),
      row({ id: "d", resolvedAt: at(2000) }),
      row({ id: "e", kind: "reply" }),
    ];
    expect(badgeCount(rows)).toBe(3);
    expect(badgeCount([])).toBe(0);
  });
});

describe("inboxStep", () => {
  test("shows the new ones oldest first, reads what the person is looking at", () => {
    const rows = [
      row({ id: "late", canvasId: "cnv_2", createdAt: at(3000), updatedAt: at(3000) }),
      row({ id: "early", canvasId: "cnv_2", createdAt: at(2000), updatedAt: at(2000) }),
      row({ id: "here", canvasId: "cnv_1", kind: "reply", link: { open: "thread" } }),
    ];
    const step = inboxStep(rows, new Set(), ctx({ looking: "cnv_1", now: LAUNCH + 4000 }));
    expect(step.show.map((r) => r.id)).toEqual(["early", "late"]);
    expect(step.read).toEqual(["here"]);
    expect(step.remove).toEqual([]);
  });

  test("a banner goes once its row leaves the inbox, is read, or its question closes", () => {
    const rows = [
      row({ id: "kept" }),
      row({ id: "read", readAt: at(2000) }),
      row({ id: "answered", resolvedAt: at(2000) }),
    ];
    const step = inboxStep(rows, new Set(["kept", "read", "answered", "gone"]), ctx());
    expect(step.remove).toEqual(["read", "answered", "gone"]);
  });

  test("a closed question is not read for being looked at: it is done with already", () => {
    const step = inboxStep([row({ resolvedAt: at(2000) })], new Set(), ctx({ looking: "cnv_1" }));
    expect(step.read).toEqual([]);
  });
});

describe("where a banner goes", () => {
  test("a question opens its thread on the question, naming the notification", () => {
    expect(linkOfRow(row())).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
      open: "thread",
      questionId: "q_1",
      notificationId: "ntf_1",
    });
  });

  test("a comment opens its pin; a pull request its tab", () => {
    expect(
      linkOfRow(
        row({
          kind: "teammate_comment",
          link: { open: "comment", pageId: "pg_1", artboardId: "ab_1", commentThreadId: "ct_1" },
        }),
      ),
    ).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
      open: "comment",
      pageId: "pg_1",
      artboardId: "ab_1",
      commentThreadId: "ct_1",
      notificationId: "ntf_1",
    });
    expect(linkOfRow(row({ kind: "pr_ready", link: { open: "pull-request" } }))).toEqual({
      kind: "canvas",
      canvasId: "cnv_1",
      open: "pull-request",
      notificationId: "ntf_1",
    });
  });

  test("a billing ping has no canvas: Plan and usage, grouped by its workspace", () => {
    const billing = row({
      kind: "billing_cap_warning",
      canvasId: null,
      title: "Northbrook",
      body: "Northbrook has used $80 of its $100 cap this month.",
      link: { open: "usage" },
    });
    expect(noticeOfRow(billing)).toEqual({
      id: "ntf_1",
      groupId: "ws_1",
      title: "Northbrook",
      body: "Northbrook has used $80 of its $100 cap this month.",
      // Its own workspace's plan, whichever the window shows.
      link: { kind: "settings", section: "usage", workspaceId: "ws_1", notificationId: "ntf_1" },
    });
  });

  test("a row naming nowhere it can open shows no banner", () => {
    expect(noticeOfRow(row({ canvasId: null, link: { open: "thread" } }))).toBeNull();
    expect(
      noticeOfRow(row({ canvasId: null, workspaceId: null, link: { open: "usage" } })),
    ).toBeNull();
  });

  test("the banner carries the row's own words and nothing else", () => {
    expect(noticeOfRow(row({ subtitle: "Northbrook" }))).toEqual({
      id: "ntf_1",
      groupId: "cnv_1",
      title: "Onboarding flow",
      subtitle: "Northbrook",
      body: "Ponzu has a question for you.",
      link: {
        kind: "canvas",
        canvasId: "cnv_1",
        open: "thread",
        questionId: "q_1",
        notificationId: "ntf_1",
      },
    });
  });
});

describe("the person at this Mac", () => {
  test("focused, with input in the last two minutes", () => {
    const now = LAUNCH;
    expect(isActive({ focused: true, lastInputAt: now - 120_000, now })).toBe(true);
    expect(isActive({ focused: true, lastInputAt: now - 120_001, now })).toBe(false);
    expect(isActive({ focused: false, lastInputAt: now, now })).toBe(false);
  });
});

describe("the time zone", () => {
  test("sent only when this computer's differs from the one kept", () => {
    expect(timeZoneToSend(null, "Europe/London")).toBe("Europe/London");
    expect(timeZoneToSend("America/New_York", "Europe/London")).toBe("Europe/London");
    expect(timeZoneToSend("Europe/London", "Europe/London")).toBeNull();
    expect(timeZoneToSend("Europe/London", undefined)).toBeNull();
  });
});
