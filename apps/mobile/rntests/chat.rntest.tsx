import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { ApiError } from "@ponzu/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as WebBrowser from "expo-web-browser";
import type { ToCanvas } from "../canvas/protocol";
import { backend, CHAT_SCENE, stockChat } from "../lib/cloud/backend.fake";
import { CloudProvider } from "../lib/cloud/query";
import { drafts } from "../lib/drafts";
import { WindowInsetsProvider } from "../lib/window-insets";

/*
 * The chat sheet on the canvas screen (components/chat-sheet.tsx), against the in-app fake
 * backend with its agent's turns played by the test: Ponzu's lines, the working line, Stop,
 * a message mid-run, a picture with it, a send that doesn't go, and a link that goes to a board.
 */

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
jest.mock("../canvas/dist/bundle", () => ({ canvasHtml: "<html>__ASSETS__</html>" }), {
  virtual: true,
});
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn(async () => ({})) }));
// A picked photo's bytes, as the file on disk would give them.
jest.mock("expo-file-system", () => ({
  ...jest.requireActual<object>("expo-file-system"),
  File: class {
    async arrayBuffer() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    }
  },
}));

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  ...(jest.requireActual("expo-router") as object),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ setOptions: () => {} }),
  useIsFocused: () => true,
  router: { replace: jest.fn(), push: mockPush, back: jest.fn(), canGoBack: () => true },
}));

const CanvasScreen = require("../app/canvas/[id]").default as () => React.JSX.Element;

const pricing = () =>
  [...backend.world.fake.canvases.values()].find(
    (c) => c.repoId === backend.world.acme.repos[0]!.id,
  )!;
const agent = () => backend.world.fake.agent(pricing().id);
const sent = (kind: ToCanvas["t"]) => mockPage.got.filter((m) => m.t === kind);

async function openPricing(params: Record<string, string> = {}) {
  mockParams = { id: pricing().id, ...params };
  await render(
    <WindowInsetsProvider>
      <CloudProvider>
        <CanvasScreen />
      </CloudProvider>
    </WindowInsetsProvider>,
  );
  await waitFor(() => expect(mockPage.say).not.toBeNull());
  await act(async () => mockPage.say!({ t: "ready" }));
  await waitFor(() => expect(sent("doc").length).toBeGreaterThan(0));
}

async function openChat() {
  await waitFor(() => expect(screen.getByTestId("stack-chat")).toBeTruthy());
  await fireEvent.press(screen.getByTestId("stack-chat"));
  await screen.findByTestId("chat-sheet");
}

async function typeAndSend(words: string) {
  await fireEvent.changeText(screen.getByTestId("chat-input"), words);
  await act(async () => {
    fireEvent(screen.getByLabelText("Send"), "accessibilityTap");
  });
}

beforeEach(async () => {
  mockPage.got = [];
  mockPage.say = null;
  mockPush.mockClear();
  drafts.clear();
  await AsyncStorage.clear();
  backend.reset();
  await backend.prepare();
  await stockChat(backend.world);
  backend.seed("signed-in");
});
afterEach(() => {
  jest.restoreAllMocks();
  (global as { picked?: unknown }).picked = undefined;
});

describe("the chat sheet", () => {
  test("Ponzu's lines: the person's bubbles, the reply's words, the aside while it runs, the working line", async () => {
    await openPricing();
    await openChat();
    expect(await screen.findByText(CHAT_SCENE.ask)).toBeTruthy();
    expect(screen.getByText(CHAT_SCENE.again)).toBeTruthy();
    // The reply drawn from its Markdown: the bold and the link are words, not markers.
    expect(screen.getByText(/I put the/)).toBeTruthy();
    expect(screen.queryByText(/\*\*/)).toBeNull();
    expect(screen.getByTestId("chat-aside")).toBeTruthy();
    expect(screen.getByText(CHAT_SCENE.aside)).toBeTruthy();
    expect(screen.getByTestId("chat-working")).toBeTruthy();
    expect(screen.getByText(CHAT_SCENE.working)).toBeTruthy();
    // No tool line, ever.
    expect(screen.queryByText("Edited Plans")).toBeNull();

    // The turn ends with its answer: the aside goes, the answer stays, the working line goes.
    await act(async () => {
      const id = agent().tool("Edited Plans", { streaming: false });
      void id;
      agent().say("The dark plans are on the board.");
      agent().idle();
    });
    await waitFor(() => expect(screen.queryByTestId("chat-working")).toBeNull());
    expect(screen.queryByText(CHAT_SCENE.aside)).toBeNull();
    expect(screen.getByText("The dark plans are on the board.")).toBeTruthy();
  });

  test("Stop while it works with the field empty: the turn ends and the thread says who", async () => {
    await openPricing();
    await openChat();
    const stop = await screen.findByLabelText("Stop");
    await act(async () => {
      fireEvent(stop, "accessibilityTap");
    });
    await waitFor(() => expect(pricing().stops).toEqual([backend.world.maya.id]));
    expect(await screen.findByText("You stopped it")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Stop")).toBeNull());
  });

  test("a message mid-run goes straight in; typing turns Stop into Send", async () => {
    await openPricing();
    await openChat();
    await screen.findByLabelText("Stop");
    await fireEvent.changeText(screen.getByTestId("chat-input"), "Also the footer");
    expect(screen.queryByLabelText("Stop")).toBeNull();
    await act(async () => {
      fireEvent(screen.getByLabelText("Send"), "accessibilityTap");
    });
    await waitFor(() =>
      expect(
        pricing().thread.some(
          ({ item }) => item.kind === "message" && item.payload.text === "Also the footer",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Also the footer")).toBeTruthy();
    expect(screen.getByTestId("chat-input").props.value).toBe("");
    // The agent was never stopped for it.
    expect(pricing().stops).toEqual([]);
  });

  test("a picture goes up and with the message", async () => {
    (global as { picked?: unknown }).picked = [
      { uri: "file:///shot.png", fileName: "shot.png", mimeType: "image/png", assetId: "s" },
    ];
    await openPricing();
    await openChat();
    await fireEvent.press(screen.getByLabelText("Attach"));
    expect(await screen.findByLabelText("Remove shot.png")).toBeTruthy();
    await typeAndSend("Like this");
    await waitFor(() =>
      expect(
        pricing().thread.find(
          ({ item }) => item.kind === "message" && item.payload.text === "Like this",
        )?.item.payload,
      ).toMatchObject({
        attachments: [
          { ref: expect.stringMatching(/^assets\/shot-.+\.png$/), contentType: "image/png" },
        ],
      }),
    );
    expect(screen.queryByLabelText("Remove shot.png")).toBeNull();
  });

  test("a send that doesn't go keeps the words and the picture; tapping the line sends again", async () => {
    (global as { picked?: unknown }).picked = [
      { uri: "file:///shot.png", fileName: "shot.png", mimeType: "image/png", assetId: "s" },
    ];
    await openPricing();
    await openChat();
    await fireEvent.press(screen.getByLabelText("Attach"));
    await screen.findByLabelText("Remove shot.png");
    const refused = jest
      .spyOn(backend.api.canvases, "sendMessage")
      .mockRejectedValueOnce(new ApiError(0, "network", "offline"));
    await typeAndSend("Try this");
    expect(await screen.findByText("Couldn't send. Tap to try again.")).toBeTruthy();
    expect(screen.getByTestId("chat-input").props.value).toBe("Try this");
    expect(screen.getByLabelText("Remove shot.png")).toBeTruthy();
    // The bubble went with the failure: the words are in the field, once.
    expect(screen.queryAllByText("Try this")).toHaveLength(0);
    refused.mockRestore();
    await act(async () => {
      fireEvent.press(screen.getByTestId("chat-line"));
    });
    await waitFor(() =>
      expect(
        pricing().thread.some(
          ({ item }) => item.kind === "message" && item.payload.text === "Try this",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByTestId("chat-line")).toBeNull());
  });

  test("a billing refusal says only its first sentence and that the canvas waits", async () => {
    await openPricing();
    await openChat();
    jest.spyOn(backend.api.canvases, "sendMessage").mockRejectedValueOnce(
      new ApiError(
        402,
        // Billing's own codes come with its gate (W6 B2); the phone reads the status alone.
        "credits_used_up" as ConstructorParameters<typeof ApiError>[1],
        "Acme's free credits for this month are used up. Add a card on your Mac to keep going.",
      ),
    );
    await typeAndSend("One more");
    expect(
      await screen.findByText("Acme's free credits for this month are used up. This canvas waits."),
    ).toBeTruthy();
    expect(screen.queryByText(/Add a card/)).toBeNull();
  });

  test("a link to a board of this canvas closes the sheet and goes there; another link leaves the app", async () => {
    await openPricing();
    await openChat();
    const link = await screen.findByText("the Plans board");
    mockPage.got = [];
    const seen = jest.spyOn(backend.api.canvases, "seen");
    const last = pricing().thread.at(-1)!.item.seq;
    await act(async () => {
      fireEvent.press(link);
    });
    await waitFor(() => expect(screen.queryByTestId("chat-sheet")).toBeNull());
    expect(sent("focus").at(-1)).toEqual({ t: "focus", artboardId: "ab_plans" });
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    // Leaving by the link is closing the sheet: the thread is read as far as it held.
    expect(seen).toHaveBeenCalledWith(pricing().id, expect.objectContaining({ threadSeq: last }));

    await act(async () => {
      agent().say("Read [the docs](https://example.com/docs) or [this](javascript:alert(1)).");
    });
    await openChat();
    await act(async () => {
      fireEvent.press(await screen.findByText("the docs"));
    });
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith("https://example.com/docs");
    // The javascript: link is only words: the reply holds one link, the safe one.
    const reply = screen.getByText(/or this\./);
    expect(reply.props.onPress).toBeUndefined();
    expect(screen.queryAllByRole("link", { name: "the docs" })).toHaveLength(1);
    expect(screen.queryAllByRole("link", { name: "this" })).toHaveLength(0);
  });

  test("a link to another canvas opens it, and this sheet closes with its thread read", async () => {
    await openPricing();
    await act(async () => {
      agent().say("See [the other one](https://ponzu.design/canvases/cnv_0000000000000099).");
    });
    await openChat();
    const link = await screen.findByText("the other one");
    (WebBrowser.openBrowserAsync as jest.Mock).mockClear();
    const seen = jest.spyOn(backend.api.canvases, "seen");
    const last = pricing().thread.at(-1)!.item.seq;
    await act(async () => {
      fireEvent.press(link);
    });
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("cnv_0000000000000099"));
    await waitFor(() => expect(screen.queryByTestId("chat-sheet")).toBeNull());
    expect(seen).toHaveBeenCalledWith(pricing().id, expect.objectContaining({ threadSeq: last }));
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  test("opened by a link (sheet=chat): up at once, and its field waits for a tap", async () => {
    await openPricing({ sheet: "chat" });
    expect(await screen.findByTestId("chat-sheet")).toBeTruthy();
    expect(screen.queryByTestId("canvas-stack")).toBeNull();
  });

  test("closing the sheet marks the thread read as far as it held", async () => {
    const seen = jest.spyOn(backend.api.canvases, "seen");
    await openPricing({ sheet: "chat" });
    await screen.findByText(CHAT_SCENE.again);
    seen.mockClear();
    const last = pricing().thread.at(-1)!.item.seq;
    // Closed as VoiceOver closes it (its escape), which a swipe down does too.
    await act(async () => {
      fireEvent(screen.getByTestId("chat-sheet"), "accessibilityEscape");
    });
    await waitFor(() => expect(screen.queryByTestId("chat-sheet")).toBeNull());
    expect(seen).toHaveBeenCalledWith(pricing().id, expect.objectContaining({ threadSeq: last }));
    expect(screen.getByTestId("canvas-stack")).toBeTruthy();
  });

  test("on a canvas the person may only read, the field is the read-only line", async () => {
    const repo = backend.world.fake.workspaces.get(backend.world.acme.id)!.repos[0]!;
    repo.access.set(backend.world.maya.id, "read");
    await openPricing({ sheet: "chat" });
    expect(await screen.findByTestId("chat-read-only")).toBeTruthy();
    expect(
      screen.getByText("You can look at this canvas. Steering it takes push access to acme/site."),
    ).toBeTruthy();
    expect(screen.queryByTestId("chat-input")).toBeNull();
  });
});
