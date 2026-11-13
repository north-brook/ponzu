import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ToCanvas } from "../canvas/protocol";
import { backend, stockChat } from "../lib/cloud/backend.fake";
import { CloudProvider } from "../lib/cloud/query";
import { drafts } from "../lib/drafts";
import { PANEL_WIDTH } from "../lib/duo-layout";
import { WindowInsetsProvider } from "../lib/window-insets";

/*
 * The canvas screen in a window as wide as an iPad's (lib/duo-layout.ts): the chat docks beside
 * the canvas as a panel, the canvas frames its boards in what it leaves, and the stack stays in
 * reach, its Chat closing the panel. A phone's window keeps the chat a sheet over everything.
 */

// The window the screen lays itself out in, set per test.
const mockWindow = { width: 1376, height: 1032, scale: 2, fontScale: 1 };
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => mockWindow,
}));

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
});

const lastInsets = () => {
  const all = sent("insets") as { t: "insets"; insets: { right: number } }[];
  return all[all.length - 1]?.insets;
};

describe("an iPad's window", () => {
  test("the chat docks beside the canvas, which frames its boards in what is left", async () => {
    Object.assign(mockWindow, { width: 1376, height: 1032 });
    await openPricing();
    expect(lastInsets()?.right).toBe(0);
    await openChat();
    // The stack stays, beside the panel, and the page leaves the panel its width.
    expect(screen.getByTestId("canvas-stack")).toBeTruthy();
    await waitFor(() => expect(lastInsets()?.right).toBe(PANEL_WIDTH + 16));
    // Chat again closes it, and the canvas has the window back.
    await fireEvent.press(screen.getByTestId("stack-chat"));
    await waitFor(() => expect(screen.queryByTestId("chat-sheet")).toBeNull());
    await waitFor(() => expect(lastInsets()?.right).toBe(0));
  });

  test("an 11-inch iPad upright (834pt) keeps the chat a sheet, the stack under it", async () => {
    Object.assign(mockWindow, { width: 834, height: 1194 });
    await openPricing();
    await openChat();
    expect(screen.queryByTestId("canvas-stack")).toBeNull();
    expect(lastInsets()?.right).toBe(0);
  });
});

describe("an iPhone's window", () => {
  test("the chat is the sheet over the canvas, as before", async () => {
    Object.assign(mockWindow, { width: 402, height: 874 });
    await openPricing();
    await openChat();
    expect(screen.queryByTestId("canvas-stack")).toBeNull();
    expect(lastInsets()?.right).toBe(0);
    await act(async () => {});
  });
});

describe("standby", () => {
  const boards = () => {
    const docs = sent("doc") as { t: "doc"; doc: { pages: { artboards: { id: string }[] }[] } }[];
    return docs[0]!.doc.pages[0]!.artboards.map((a) => a.id);
  };
  const lastStandby = () => {
    const all = sent("standby") as { t: "standby"; on: boolean }[];
    return all[all.length - 1]?.on;
  };

  test("while Ponzu works on this page: the page alone, the camera on the boards it works on", async () => {
    Object.assign(mockWindow, { width: 402, height: 874 });
    // The simulator has no hinge or motion: the fake backend's `standby=1` stands in for both.
    await openPricing({ standby: "1" });
    const [first, second] = boards();
    // The stock canvas opens with Ponzu at work: let it rest first.
    await act(async () => agent().idle());
    await waitFor(() => expect(screen.queryByTestId("standby")).toBeNull());
    await act(async () => agent().work([first!, second!], "Drawing the plans"));
    await screen.findByTestId("standby");
    expect(screen.getByTestId("chrome-hidden", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId("canvas-stack")).toBeNull();
    await waitFor(() => expect(lastStandby()).toBe(true));
    await waitFor(() =>
      expect(sent("follow")).toContainEqual(expect.objectContaining({ artboardId: first })),
    );
    // Ponzu stops: standby goes, and the chrome comes back.
    await act(async () => agent().idle());
    await waitFor(() => expect(screen.queryByTestId("standby")).toBeNull());
    expect(screen.getByTestId("chrome")).toBeTruthy();
    expect(lastStandby()).toBe(false);
  });

  test("an iPhone in the hand never goes to standby, however Ponzu works", async () => {
    Object.assign(mockWindow, { width: 402, height: 874 });
    await openPricing();
    const [first] = boards();
    await act(async () => agent().work([first!], "Drawing the plans"));
    await waitFor(() => expect(screen.getByTestId("stack-chat-working")).toBeTruthy());
    expect(screen.queryByTestId("standby")).toBeNull();
    expect(sent("follow")).toEqual([]);
  });
});
