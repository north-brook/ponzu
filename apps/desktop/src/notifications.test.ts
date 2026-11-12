import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeepLink, MacNotice } from "./bridge.ts";
import {
  createNotifier,
  deviceNameOf,
  installIdIn,
  KEPT_MAX,
  type NotificationClass,
  noticeOf,
} from "./notifications.ts";

/** Electron's Notification, played: every one made, what it was made with, and its events. */
function fakeNotifications() {
  const made: FakeShown[] = [];
  const removed: string[][] = [];
  class FakeShown {
    readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    shown = false;
    closed = false;
    constructor(readonly options: ConstructorParameters<NotificationClass>[0]) {
      made.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    show() {
      this.shown = true;
    }
    close() {
      this.closed = true;
    }
    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
    static remove(ids: string[]) {
      removed.push(ids);
    }
  }
  return { Notification: FakeShown as unknown as NotificationClass, made, removed };
}

function world() {
  const fake = fakeNotifications();
  const opened: DeepLink[] = [];
  const failed: string[] = [];
  const badges: number[] = [];
  const notifier = createNotifier({
    Notification: fake.Notification,
    setBadge: (count) => badges.push(count),
    open: (link) => opened.push(link),
    failed: (id) => failed.push(id),
  });
  return { ...fake, notifier, opened, failed, badges };
}

const QUESTION: MacNotice = {
  id: "ntf_1",
  groupId: "cnv_1",
  title: "Onboarding flow",
  body: "Ponzu has a question for you.",
  link: {
    kind: "canvas",
    canvasId: "cnv_1",
    open: "thread",
    questionId: "q_1",
    notificationId: "ntf_1",
  },
};

describe("a banner", () => {
  test("is shown with its words, grouped by its canvas, and not silent", () => {
    const { notifier, made } = world();
    notifier.show(QUESTION);
    expect(made.map((n) => [n.options, n.shown])).toEqual([
      [
        {
          id: "ntf_1",
          groupId: "cnv_1",
          title: "Onboarding flow",
          body: "Ponzu has a question for you.",
          silent: false,
        },
        true,
      ],
    ]);
    expect(notifier.kept).toBe(1);
  });

  test("a click hands its link back and lets it go", () => {
    const { notifier, made, opened } = world();
    notifier.show(QUESTION);
    made[0]!.emit("click");
    expect(opened).toEqual([QUESTION.link]);
    expect(notifier.kept).toBe(0);
  });

  test("closed by the person, it is let go and opens nothing", () => {
    const { notifier, made, opened } = world();
    notifier.show(QUESTION);
    made[0]!.emit("close");
    expect([opened.length, notifier.kept]).toEqual([0, 0]);
  });

  test("the same id again replaces it: the earlier one closes", () => {
    const { notifier, made, opened } = world();
    notifier.show({ ...QUESTION, id: "ntf_9", body: "Sam commented." });
    notifier.show({ ...QUESTION, id: "ntf_9", body: "Sam left 2 comments." });
    expect(made.map((n) => [n.options.body, n.closed])).toEqual([
      ["Sam commented.", true],
      ["Sam left 2 comments.", false],
    ]);
    expect(notifier.kept).toBe(1);
    // The first one's close, heard late, doesn't let the second go.
    made[0]!.emit("close");
    expect(notifier.kept).toBe(1);
    made[1]!.emit("click");
    expect(opened.length).toBe(1);
  });

  test("one the system refuses (an unsigned build) is reported by id", () => {
    const { notifier, made, failed } = world();
    notifier.show(QUESTION);
    made[0]!.emit("failed", {}, "not signed");
    expect([failed, notifier.kept]).toEqual([["ntf_1"], 0]);
  });

  test("at most 50 are kept hold of; the oldest is let go", () => {
    const { notifier, made, opened } = world();
    for (let i = 0; i < KEPT_MAX + 5; i++) notifier.show({ ...QUESTION, id: `ntf_${i}` });
    expect(notifier.kept).toBe(KEPT_MAX);
    // The oldest still shows in Notification Center; a click on it no longer reaches here.
    made[0]!.emit("click");
    made[KEPT_MAX + 4]!.emit("click");
    expect(opened.length).toBe(2);
  });

  test("a billing ping opens Plan and usage", () => {
    const { notifier, made, opened } = world();
    const link: DeepLink = { kind: "settings", section: "usage", notificationId: "ntf_5" };
    notifier.show({ id: "ntf_5", groupId: "ws_1", title: "Northbrook", body: "Used.", link });
    made[0]!.emit("click");
    expect(opened).toEqual([link]);
  });
});

describe("taking banners away", () => {
  test("closes the ones kept and clears Notification Center by id", () => {
    const { notifier, made, removed } = world();
    notifier.show(QUESTION);
    notifier.remove(["ntf_1", "ntf_gone"]);
    expect(made[0]!.closed).toBe(true);
    expect(removed).toEqual([["ntf_1", "ntf_gone"]]);
    expect(notifier.kept).toBe(0);
  });

  test("anything but a list of ids is ignored", () => {
    const { notifier, removed } = world();
    notifier.remove("ntf_1");
    notifier.remove([1, null, "../x"]);
    expect(removed).toEqual([]);
  });
});

describe("the dock's badge", () => {
  test("takes whole numbers from none up, at most 9999", () => {
    const { notifier, badges } = world();
    for (const value of [3, 0, -1, 2.5, "4", Number.NaN, 120_000]) notifier.setBadge(value);
    expect(badges).toEqual([3, 0, 9999]);
  });
});

describe("what the studio sends is checked as if anyone had sent it", () => {
  test("a notice exactly as it should be survives whole", () => {
    expect(noticeOf({ ...QUESTION, subtitle: "Northbrook" })).toEqual({
      ...QUESTION,
      subtitle: "Northbrook",
    });
  });

  test.each([
    ["no id", { ...QUESTION, id: "" }],
    ["an id with a slash", { ...QUESTION, id: "ntf/1" }],
    ["a group with a colon", { ...QUESTION, groupId: "cnv_1:comments" }],
    ["an empty title", { ...QUESTION, title: "  " }],
    ["a body past 200 characters", { ...QUESTION, body: "x".repeat(201) }],
    ["a subtitle that isn't words", { ...QUESTION, subtitle: 5 }],
    ["no link", { ...QUESTION, link: undefined }],
    ["a GitHub setup link", { ...QUESTION, link: { kind: "github_setup", result: "installed" } }],
    [
      "a sign-in's way back",
      { ...QUESTION, link: { kind: "auth_callback", code: "a", state: "b" } },
    ],
    ["a canvas id that isn't one", { ...QUESTION, link: { kind: "canvas", canvasId: "../x" } }],
    ["not an object", "ntf_1"],
  ])("%s is dropped", (_why, value) => {
    const { notifier, made } = world();
    expect(noticeOf(value)).toBeNull();
    notifier.show(value);
    expect(made.length).toBe(0);
  });

  test("a link's parts it can't take are left out, not passed on", () => {
    const notice = noticeOf({
      ...QUESTION,
      link: { kind: "canvas", canvasId: "cnv_1", open: "thread", extra: "javascript:x" },
    });
    expect(notice?.link).toEqual({ kind: "canvas", canvasId: "cnv_1", open: "thread" });
  });
});

describe("this install", () => {
  test("its id is made once and kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "ponzu-install-"));
    try {
      const file = join(dir, "nested", "install-id");
      let made = 0;
      const make = () => `0f9c2a1e-1b7d-4c55-9a0e-${String(++made).padStart(12, "0")}`;
      const first = installIdIn(file, make);
      expect(installIdIn(file, make)).toBe(first);
      expect(readFileSync(file, "utf8")).toBe(first);
      expect(made).toBe(1);
      // A file cut short or edited is made again.
      writeFileSync(file, "short");
      const again = installIdIn(file, make);
      expect([again === first, made]).toEqual([false, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the computer's name loses .local; none is null", () => {
    expect(deviceNameOf("Mayas-MacBook-Pro.local")).toBe("Mayas-MacBook-Pro");
    expect(deviceNameOf("studio")).toBe("studio");
    expect(deviceNameOf(" .local")).toBeNull();
    expect(deviceNameOf("x".repeat(300))?.length).toBe(100);
  });
});
