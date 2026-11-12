import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { ApiError } from "@ponzu/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ToCanvas } from "../canvas/protocol";
import { backend } from "../lib/cloud/backend.fake";
import { CloudProvider } from "../lib/cloud/query";
import { drafts } from "../lib/drafts";
import { WindowInsetsProvider } from "../lib/window-insets";

/*
 * Comments on the canvas screen (app/canvas/[id].tsx), against the in-app fake backend: the
 * screen's own replica and bridge, its composer and sheets. The web view is a stand-in that
 * keeps what the app tells the page and lets a test speak as the page (`ready`, a hold, a pin
 * tapped), so the test sees exactly what the canvas would be told to draw.
 */

/** What the page was told, in order, and the way to speak as it. */
const mockPage: { got: ToCanvas[]; say: ((msg: object) => void) | null } = { got: [], say: null };

jest.mock("react-native-webview", () => {
  const React = require("react");
  const { View } = require("react-native");
  const PREFIX = "window.__ponzuCanvas&&window.__ponzuCanvas.receive(";
  const WebView = React.forwardRef(function WebView(
    props: { onMessage: (e: object) => void },
    ref: unknown,
  ) {
    React.useImperativeHandle(ref, () => ({
      injectJavaScript: (js: string) => {
        if (js.startsWith(PREFIX))
          mockPage.got.push(JSON.parse(js.slice(PREFIX.length, -";true;".length - 1)));
      },
    }));
    mockPage.say = (msg) => props.onMessage({ nativeEvent: { data: JSON.stringify(msg) } });
    return React.createElement(View, { testID: "canvas-web" });
  });
  return { WebView };
});
// The built page: its policy's placeholder is all the app reads of it.
jest.mock("../canvas/dist/bundle", () => ({ canvasHtml: "<html>__ASSETS__</html>" }), {
  virtual: true,
});

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  ...(jest.requireActual("expo-router") as object),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ setOptions: () => {} }),
  useIsFocused: () => true,
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));

const CanvasScreen = require("../app/canvas/[id]").default as () => React.JSX.Element;

const world = backend.world;
const pricing = () =>
  [...world.fake.canvases.values()].find((c) => c.repoId === world.acme.repos[0]!.id)!;
const sent = (kind: ToCanvas["t"]) => mockPage.got.filter((m) => m.t === kind);
const say = async (msg: object) => {
  await act(async () => mockPage.say!(msg));
};
/**
 * Type into the open field (switching from voice, which opens first and has no microphone
 * here) and press Send as VoiceOver does. What the page was told before is forgotten first.
 */
async function typeAndSend(words: string) {
  const toType = screen.queryByTestId("to-type");
  if (toType) await fireEvent.press(toType);
  await fireEvent.changeText(screen.getByTestId("comment-input"), words);
  mockPage.got = [];
  await act(async () => {
    fireEvent(screen.getByLabelText("Send"), "accessibilityTap");
  });
}

/** The Pricing page open on Maya's phone, its page ready. */
async function openPricing() {
  mockParams = { id: pricing().id };
  await render(
    <WindowInsetsProvider>
      <CloudProvider>
        <CanvasScreen />
      </CloudProvider>
    </WindowInsetsProvider>,
  );
  await waitFor(() => expect(mockPage.say).not.toBeNull());
  await say({ t: "ready" });
  await waitFor(() => expect(sent("doc").length).toBeGreaterThan(0));
}

const commentEnabled = () =>
  screen.getByTestId("stack-comment").props.accessibilityState?.disabled === false;

beforeEach(async () => {
  mockPage.got = [];
  mockPage.say = null;
  drafts.clear();
  await AsyncStorage.clear();
  await backend.prepare();
  backend.seed("signed-in");
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("comments on a canvas", () => {
  test("Comment, a tap, words, Send: the comment is on the canvas at once, then the API's", async () => {
    await openPricing();
    await waitFor(() => expect(commentEnabled()).toBe(true));
    await fireEvent.press(screen.getByTestId("stack-comment"));
    expect(screen.getByText("Tap where your comment goes")).toBeTruthy();
    expect(sent("commenting").at(-1)).toEqual({ t: "commenting", on: true });

    // The page answers the tap with where it landed.
    const pageId = pricing().sequencer.doc.pages[0]!.id;
    await say({ t: "longpress", pageId, artboardId: "ab_plans", x: 40, y: 60 });
    expect(screen.getByTestId("comment-sheet")).toBeTruthy();
    expect(sent("commenting").at(-1)).toEqual({ t: "commenting", on: false });
    await typeAndSend("Bigger prices");

    // Told to the page as an op the moment it was applied.
    const op = sent("op").find((m) => m.t === "op" && m.op.op === "thread.create");
    expect(op).toBeTruthy();
    const thread = op!.t === "op" && op!.op.op === "thread.create" ? op!.op.thread : null;
    expect(thread).toMatchObject({ artboardId: "ab_plans", x: 40, y: 60 });
    expect(thread!.messages[0]).toMatchObject({
      text: "Bigger prices",
      author: { name: "Maya Lin" },
    });
    // The API has it, and the words are no longer a draft.
    await waitFor(() =>
      expect(pricing().sequencer.doc.threads.map((t) => t.id)).toContain(thread!.id),
    );
    await waitFor(() => expect(drafts.snapshot()).toEqual([]));

    // Its pin opens its thread, under the name of who wrote it.
    await say({ t: "openThread", id: thread!.id });
    expect(screen.getByTestId("thread-sheet")).toBeTruthy();
    expect(screen.getByText("Bigger prices")).toBeTruthy();
    expect(screen.getByText("Maya Lin")).toBeTruthy();
  });

  test("a refused comment comes back with its words and the API's reason", async () => {
    await openPricing();
    await waitFor(() => expect(commentEnabled()).toBe(true));
    jest
      .spyOn(backend.api.canvases, "commit")
      .mockRejectedValueOnce(
        new ApiError(400, "invalid_request", "That comment is too long to keep."),
      );
    const pageId = pricing().sequencer.doc.pages[0]!.id;
    await say({ t: "longpress", pageId, artboardId: "ab_faq", x: 10, y: 12 });
    await typeAndSend("Way too long");

    expect(await screen.findByText("That comment is too long to keep.")).toBeTruthy();
    expect(screen.getByTestId("comment-input").props.value).toBe("Way too long");
    // Kept, to send again: the draft has its words, and nothing says it was sent.
    expect(drafts.snapshot().map(([, d]) => [d.text, d.sending])).toEqual([
      ["Way too long", undefined],
    ]);
    expect(pricing().sequencer.doc.threads.some((t) => t.artboardId === "ab_faq")).toBe(false);
  });

  test("sent while the API can't be reached: on the canvas, its words kept as sending, and it waits", async () => {
    await openPricing();
    await waitFor(() => expect(commentEnabled()).toBe(true));
    const commit = jest
      .spyOn(backend.api.canvases, "commit")
      .mockRejectedValue(new TypeError("Network request failed"));
    const pageId = pricing().sequencer.doc.pages[0]!.id;
    await say({ t: "longpress", pageId, artboardId: "ab_plans", x: 5, y: 6 });
    await typeAndSend("When you can");

    const op = sent("op").find((m) => m.t === "op" && m.op.op === "thread.create");
    const id = op?.t === "op" && op.op.op === "thread.create" ? op.op.thread.id : null;
    expect(id).toBeTruthy();
    expect(
      await screen.findByText("Saved here. Ponzu sends it when you're back online."),
    ).toBeTruthy();
    // A phone killed now still has the words, and knows which thread they were sent as.
    expect(drafts.snapshot().map(([, d]) => [d.text, d.sending])).toEqual([["When you can", id]]);
    const stored = JSON.parse((await AsyncStorage.getItem(`ponzu.drafts.${pricing().id}`)) ?? "{}");
    expect(Object.values(stored)).toEqual([expect.objectContaining({ sending: id })]);
    // Not shown twice: the sent comment is on the canvas, so no unsent pin stands for it too.
    expect(sent("unsent").flatMap((m) => (m.t === "unsent" ? m.pins : []))).toEqual([]);

    // A reply, still offline; its sheet closed and opened again: the field doesn't offer the
    // sent words a second time, though their draft keeps them until the API has them.
    await say({ t: "openThread", id });
    await typeAndSend("And the footer");
    await say({ t: "longpress", pageId, artboardId: "ab_faq", x: 1, y: 1 });
    await say({ t: "openThread", id });
    expect(screen.getByTestId("thread-sheet")).toBeTruthy();
    expect(screen.getByTestId("comment-input").props.value).toBe("");
    const reply = drafts.snapshot().find(([, d]) => d.thread === id)?.[1];
    expect(reply?.text).toBe("And the footer");
    expect(reply?.sending).toBeTruthy();
    commit.mockRestore();
  });

  test("on a canvas the person may only read, Comment is unavailable and says why", async () => {
    const repo = world.fake.workspaces.get(world.acme.id)!.repos[0]!;
    repo.access.set(world.maya.id, "read");
    try {
      await openPricing();
      await waitFor(() =>
        expect(screen.getByTestId("stack-comment").props.accessibilityHint).toBe(
          "You can look at this canvas. Steering it takes push access to acme/site.",
        ),
      );
      expect(commentEnabled()).toBe(false);
      // A hold does nothing either.
      const pageId = pricing().sequencer.doc.pages[0]!.id;
      await say({ t: "longpress", pageId, artboardId: "ab_plans", x: 1, y: 1 });
      expect(screen.queryByTestId("comment-sheet")).toBeNull();
    } finally {
      repo.access.delete(world.maya.id);
    }
  });
});
