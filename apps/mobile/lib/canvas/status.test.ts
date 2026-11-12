import { describe, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { allowLoad, assetsOrigin, pageHtml } from "./page";
import { CANVAS_WORDS, canvasStatus, previewUrl } from "./status";

const head = (over: Partial<Parameters<typeof canvasStatus>[0] & object> = {}) => ({
  agentState: "idle" as const,
  agentStatus: null,
  agentArtboards: [] as string[],
  agentBlocker: null,
  needsYouCount: 0,
  ...over,
});
const ready = { status: "ready" as const, doc: emptyDoc("Kettle") };

describe("where the canvas is", () => {
  test("waking: the title shimmers and says so, and Chat turns", () => {
    expect(canvasStatus(head({ agentState: "waking" }), ready)).toEqual({
      mood: "waking",
      line: "Waking up",
      busy: true,
      working: [],
      chat: "working",
    });
  });

  test("working: the agent's boards are ringed, with no line", () => {
    const s = canvasStatus(
      head({ agentState: "working", agentArtboards: ["ab_1", "ab_2"] }),
      ready,
    );
    expect(s).toEqual({
      mood: "working",
      line: null,
      busy: true,
      working: ["ab_1", "ab_2"],
      chat: "working",
    });
  });

  test("needs you: no ring, and the Chat button carries the count", () => {
    const s = canvasStatus(head({ agentState: "needs_you", needsYouCount: 2 }), ready);
    expect([s.mood, s.busy, s.working, s.chat]).toEqual(["needs_you", false, [], { needsYou: 2 }]);
  });

  test("asleep: quiet, unless no machine could be had", () => {
    expect(canvasStatus(head(), ready)).toEqual({
      mood: "asleep",
      line: null,
      busy: false,
      working: [],
      chat: "idle",
    });
    expect(canvasStatus(head({ agentState: "limited" }), ready).mood).toBe("asleep");
    expect(canvasStatus(head({ agentBlocker: "sandbox_failed" }), ready).line).toBe(
      "Ponzu couldn't start a machine for this canvas. Send a message to try again.",
    );
    expect(
      canvasStatus(head({ agentState: "waking", agentBlocker: "sandbox_busy" }), ready).line,
    ).toBe("Waiting for a free machine. Your messages go in as soon as one starts.");
  });

  test("offline: the last copy with its line, and no ring the head may have ended", () => {
    const working = head({ agentState: "working", agentArtboards: ["ab_1"] });
    expect(canvasStatus(working, { status: "offline", doc: ready.doc })).toMatchObject({
      mood: "offline",
      line: CANVAS_WORDS.offline,
      busy: false,
      working: [],
    });
    expect(canvasStatus(undefined, { status: "offline", doc: null }).line).toBe(
      "Can't reach Ponzu. Trying again.",
    );
  });

  test("gone, and loading", () => {
    expect(canvasStatus(head(), { status: "error", doc: null })).toMatchObject({
      mood: "gone",
      line: "That canvas isn't available to you.",
    });
    expect(canvasStatus(undefined, { status: "connecting", doc: null })).toEqual({
      mood: "loading",
      line: null,
      busy: false,
      working: [],
      chat: "idle",
    });
  });

  test("the preview is the runner's for this theme, and none before it drew one", () => {
    const view = { assetsUrl: "https://assets.ponzu.cloud/k1/", previewSeq: 12 };
    expect(previewUrl(view, "dark")).toBe("https://assets.ponzu.cloud/k1/previews/12-dark.png");
    expect(previewUrl({ ...view, previewSeq: null }, "light")).toBeNull();
    expect(previewUrl(undefined, "light")).toBeNull();
  });
});

describe("loading the page", () => {
  test("the asset origin is https with a plain host, or http on this machine", () => {
    expect(assetsOrigin("https://assets.ponzu.cloud/k1/")).toBe("https://assets.ponzu.cloud");
    expect(assetsOrigin("https://Assets.Ponzu.Cloud:8443/k1/")).toBe(
      "https://assets.ponzu.cloud:8443",
    );
    expect(assetsOrigin("http://127.0.0.1:4100/k1/")).toBe("http://127.0.0.1:4100");
    expect(assetsOrigin("http://assets.ponzu.cloud/k1/")).toBeNull();
    // Nothing that could carry a second source or directive into the policy.
    expect(assetsOrigin("https://a.b; script-src *;/k1/")).toBeNull();
    expect(assetsOrigin("https://a.b 'unsafe-inline'/k1/")).toBeNull();
    expect(assetsOrigin("https://user@a.b/k1/")).toBeNull();
    expect(assetsOrigin("javascript:alert(1)//")).toBeNull();
  });

  test("the origin goes into every place the policy names it", () => {
    const html = `<meta content="font-src __ASSETS__; img-src https: __ASSETS__">`;
    expect(pageHtml(html, "https://assets.ponzu.cloud")).toBe(
      `<meta content="font-src https://assets.ponzu.cloud; img-src https: https://assets.ponzu.cloud">`,
    );
  });

  test("the web view goes nowhere but its own first load", () => {
    const base = "https://assets.ponzu.cloud/k1/";
    expect(allowLoad(base, base)).toBe(true);
    expect(allowLoad("about:blank", base)).toBe(true);
    expect(allowLoad("https://assets.ponzu.cloud/k1/assets/x.html", base)).toBe(false);
    expect(allowLoad("https://evil.example/", base)).toBe(false);
    expect(allowLoad("ponzu://canvas/cnv_1", base)).toBe(false);
  });
});
