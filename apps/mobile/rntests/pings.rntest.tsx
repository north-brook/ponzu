import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import type { ToCanvas } from "../canvas/protocol";
import { backend } from "../lib/cloud/backend.fake";
import { CloudProvider } from "../lib/cloud/query";
import { PINGS } from "../lib/copy";
import { drafts } from "../lib/drafts";
import { listNotice, setListNotice } from "../lib/list-notice";
import { PING_ASK_KEY } from "../lib/push/ask";
import { setOnScreen } from "../lib/push/foreground";
import { devices, dropHeldTap, PingsProvider } from "../lib/push/pings";
import { WindowInsetsProvider } from "../lib/window-insets";

/*
 * Pings on the phone (lib/push), against the in-app fake backend and a stand-in for iOS's
 * notifications (`global.pings`, jest.setup.js): the ask after a comment, registering this
 * phone, Settings › Notifications, taps, and that none of it does anything while the API sends
 * no pings.
 */

declare const global: {
  pings: {
    permission: "undetermined" | "granted" | "denied";
    answer: "granted" | "denied";
    environment: "development" | "production" | null;
    calls: string[];
    badge: number | null;
    tap: ((n: object) => void) | null;
    reset(): void;
  };
};

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

let mockParams: Record<string, string> = {};
const mockSegments: { now: string[] } = { now: ["canvas", "[id]"] };
jest.mock("expo-router", () => ({
  ...(jest.requireActual("expo-router") as object),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ setOptions: () => {} }),
  useIsFocused: () => true,
  useSegments: () => mockSegments.now,
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
    canDismiss: () => false,
    dismissAll: jest.fn(),
    dismissTo: jest.fn(),
    setParams: jest.fn(),
  },
}));

const CanvasScreen = require("../app/canvas/[id]").default as () => React.JSX.Element;
const Settings = require("../app/settings").default as () => React.JSX.Element;

const push = router.push as unknown as jest.Mock;
const setParams = router.setParams as unknown as jest.Mock;
const dismissTo = router.dismissTo as unknown as jest.Mock;

const world = () => backend.world;
const pricing = () =>
  [...world().fake.canvases.values()].find((c) => c.repoId === world().acme.repos[0]!.id)!;
const sent = (kind: ToCanvas["t"]) => mockPage.got.filter((m) => m.t === kind);
const say = async (msg: object) => {
  await act(async () => mockPage.say!(msg));
};
const mayaDevices = () => world().fake.settings.devices.get(world().maya.id) ?? [];

function App({ children }: { children: React.ReactNode }) {
  return (
    <WindowInsetsProvider>
      <CloudProvider>
        <PingsProvider>{children}</PingsProvider>
      </CloudProvider>
    </WindowInsetsProvider>
  );
}

async function openPricing() {
  mockParams = { id: pricing().id };
  await render(
    <App>
      <CanvasScreen />
    </App>,
  );
  await waitFor(() => expect(mockPage.say).not.toBeNull());
  await say({ t: "ready" });
  await waitFor(() => expect(sent("doc").length).toBeGreaterThan(0));
}

/** A new comment on the Plans board, sent, and kept by the API. */
async function comment(words: string) {
  await waitFor(() =>
    expect(screen.getByTestId("stack-comment").props.accessibilityState?.disabled).toBe(false),
  );
  await fireEvent.press(screen.getByTestId("stack-comment"));
  const pageId = pricing().sequencer.doc.pages[0]!.id;
  await say({ t: "longpress", pageId, artboardId: "ab_plans", x: 40, y: 60 });
  const toType = screen.queryByTestId("to-type");
  if (toType) await fireEvent.press(toType);
  await fireEvent.changeText(screen.getByTestId("comment-input"), words);
  await act(async () => {
    fireEvent(screen.getByLabelText("Send"), "accessibilityTap");
  });
  await waitFor(() =>
    expect(
      pricing().sequencer.doc.threads.some((t) => t.messages.some((m) => m.text === words)),
    ).toBe(true),
  );
}

/** A ping as iOS hands it to the app (lib/push/payload.ts). */
const ping = (body: object) => ({
  request: { content: { data: body }, trigger: { type: "push", payload: { body } } },
});

beforeEach(async () => {
  mockPage.got = [];
  mockPage.say = null;
  mockSegments.now = ["canvas", "[id]"];
  push.mockClear();
  setParams.mockClear();
  dismissTo.mockClear();
  global.pings.reset();
  setOnScreen(null);
  setListNotice(null);
  dropHeldTap();
  drafts.clear();
  await AsyncStorage.clear();
  backend.reset();
  await backend.prepare();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("pings while the API sends none (production today)", () => {
  test("a comment asks nothing, registers nothing, keeps nothing and says nothing of focus", async () => {
    backend.seed("signed-in");
    expect((await backend.api.me()).features.push).toBe(false);
    await openPricing();
    await comment("Bigger prices");
    // Give the ask every chance to come.
    await act(async () => {});
    expect(screen.queryByTestId("ping-ask")).toBeNull();
    expect(global.pings.calls).toEqual([]);
    expect(global.pings.badge).toBeNull();
    expect(await AsyncStorage.getItem(PING_ASK_KEY)).toBeNull();
    expect(await AsyncStorage.getItem("ponzu.device")).toBeNull();
    expect(mayaDevices()).toEqual([]);
    // Presence went as before, with no word of focus.
    const here = pricing().presence.get(world().maya.id);
    expect(here).toBeTruthy();
    expect(here!.focusedAt).toBeNull();
  });

  test("Settings has no Notifications section", async () => {
    backend.seed("signed-in");
    await render(
      <App>
        <Settings />
      </App>,
    );
    expect(await screen.findByText("Maya Lin")).toBeTruthy();
    expect(screen.queryByTestId("settings-notifications")).toBeNull();
    expect(screen.queryByText(PINGS.section)).toBeNull();
  });
});

describe("pings while the API sends them", () => {
  test("the first comment asks, in onboarding's words; Turn on prompts iOS and registers this phone", async () => {
    backend.seed("pings");
    await openPricing();
    // Looking at the canvas: presence says so.
    await waitFor(() => expect(pricing().presence.get(world().maya.id)?.focusedAt).not.toBeNull());
    await comment("Bigger prices");
    expect(await screen.findByTestId("ping-ask")).toBeTruthy();
    expect(screen.getByText(PINGS.ask.title)).toBeTruthy();
    expect(screen.getByText(PINGS.ask.body)).toBeTruthy();
    expect(screen.getByRole("button", { name: PINGS.ask.notNow })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: PINGS.ask.turnOn }));
    await waitFor(() => expect(screen.queryByTestId("ping-ask")).toBeNull());
    expect(global.pings.calls).toEqual(["prompt"]);
    await waitFor(() => expect(mayaDevices()).toHaveLength(1));
    expect(mayaDevices()[0]).toMatchObject({
      platform: "ios",
      name: "iPhone 16 Pro",
      blocked: false,
    });
    expect(await devices.read(world().maya.id)).toBe(mayaDevices()[0]!.id);
  });

  test("Not now keeps quiet: the next comment asks nothing", async () => {
    backend.seed("pings");
    await openPricing();
    await comment("Bigger prices");
    await fireEvent.press(await screen.findByRole("button", { name: PINGS.ask.notNow }));
    await waitFor(() => expect(screen.queryByTestId("ping-ask")).toBeNull());
    const kept = JSON.parse((await AsyncStorage.getItem(PING_ASK_KEY))!);
    expect(kept).toMatchObject({ times: 1 });
    expect(typeof kept.declinedAt).toBe("number");
    await comment("And the footer");
    await act(async () => {});
    expect(screen.queryByTestId("ping-ask")).toBeNull();
    expect(global.pings.calls).toEqual([]);
    expect(mayaDevices()).toEqual([]);
  });

  test("allowed already: no sheet, the phone registers; refused: no sheet, nothing made", async () => {
    global.pings.permission = "granted";
    backend.seed("pings");
    // One question waiting on Maya, as the API's pipeline would have told her.
    world().fake.settings.notify(world().maya.id, {
      kind: "needs_you",
      title: "Pricing page",
      body: "Ponzu has a question for you.",
      canvasId: pricing().id,
      link: { open: "thread", questionId: "q_1" },
    });
    await openPricing();
    await waitFor(() => expect(mayaDevices()).toHaveLength(1));
    await comment("Bigger prices");
    await act(async () => {});
    expect(screen.queryByTestId("ping-ask")).toBeNull();
    expect(global.pings.calls).toEqual([]);
    // The icon's number is the API's count of open questions.
    await waitFor(() => expect(global.pings.badge).toBe(1));
  });

  test("on the simulator (no APNs environment) Turn on registers nothing, and says nothing broken", async () => {
    global.pings.environment = null;
    backend.seed("pings");
    await openPricing();
    await comment("Bigger prices");
    await fireEvent.press(await screen.findByRole("button", { name: PINGS.ask.turnOn }));
    await waitFor(() => expect(screen.queryByTestId("ping-ask")).toBeNull());
    expect(mayaDevices()).toEqual([]);
  });

  test("Settings: the events in the Mac's words, and this iPhone's Pings, or where to turn them on", async () => {
    global.pings.permission = "granted";
    backend.seed("pings");
    await render(
      <App>
        <Settings />
      </App>,
    );
    expect(await screen.findByTestId("settings-notifications")).toBeTruthy();
    for (const event of PINGS.events) expect(screen.getByText(event.title)).toBeTruthy();
    expect(await screen.findByText(PINGS.thisIphone)).toBeTruthy();
    expect(screen.getByText(PINGS.settings.pings)).toBeTruthy();
    await fireEvent(screen.getByTestId("settings-ping-replies-switch"), "valueChange", false);
    await waitFor(async () =>
      expect((await backend.api.notifications.get()).prefs.replies).toBe(false),
    );
  });

  test("Settings when iOS refused: Turned off in iOS Settings, with the way there", async () => {
    global.pings.permission = "denied";
    backend.seed("pings");
    await render(
      <App>
        <Settings />
      </App>,
    );
    expect(await screen.findByText(PINGS.settings.blocked)).toBeTruthy();
    expect(screen.getByRole("button", { name: PINGS.openSettings })).toBeTruthy();
  });
});

describe("taps on pings", () => {
  const question = () => ({
    v: 1,
    n: "ntf_1",
    k: "needs_you",
    c: pricing().id,
    w: world().acme.id,
    o: "thread",
    q: "q_7",
  });

  test("a cold-start tap waits for the person signed in and off the launch screen, then opens the chat and reads the ping", async () => {
    mockSegments.now = ["index"];
    // A cold start: the session is still being read from the Keychain.
    (backend.session as unknown as { set(state: object): void }).set({ status: "loading" });
    await render(<App>{null}</App>);
    await waitFor(() => expect(global.pings.tap).not.toBeNull());
    await act(async () => global.pings.tap!(ping(question())));
    // Still loading: nothing moves.
    expect(push).not.toHaveBeenCalled();
    await act(async () => {
      backend.seed("pings");
    });
    await act(async () => {});
    // Signed in, but the launch screen still shows: nothing yet.
    expect(push).not.toHaveBeenCalled();
    mockSegments.now = ["(tabs)", "(canvases)", "canvases"];
    await screen.rerender(<App>{null}</App>);
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        `/canvas/${pricing().id}?sheet=chat&question=q_7&ping=ntf_1`,
      ),
    );
    expect(push).toHaveBeenCalledTimes(1);
  });

  test("a tap while signed out is dropped, and never opens for whoever signs in next", async () => {
    backend.seed("signed-out");
    mockSegments.now = ["sign-in"];
    await render(<App>{null}</App>);
    await waitFor(() => expect(global.pings.tap).not.toBeNull());
    await act(async () => global.pings.tap!(ping(question())));
    await act(async () => {
      backend.seed("pings");
    });
    mockSegments.now = ["(tabs)", "(canvases)", "canvases"];
    await screen.rerender(<App>{null}</App>);
    await act(async () => {});
    expect(push).not.toHaveBeenCalled();
  });

  test("a ping naming nothing this app opens goes to the canvases, saying so", async () => {
    backend.seed("pings");
    mockSegments.now = ["(tabs)", "(canvases)", "canvases"];
    await render(<App>{null}</App>);
    await waitFor(() => expect(global.pings.tap).not.toBeNull());
    await act(async () => global.pings.tap!(ping({ url: "evil://canvas/cnv_x?sheet=chat" })));
    await waitFor(() => expect(dismissTo).toHaveBeenCalledWith("/canvases"));
    expect(push).not.toHaveBeenCalled();
    expect(listNotice()).toBe("That canvas isn't available to you.");
  });

  test("a tap for the canvas on screen opens its chat in place", async () => {
    backend.seed("pings");
    await openPricing();
    await waitFor(() => expect(global.pings.tap).not.toBeNull());
    await act(async () => global.pings.tap!(ping(question())));
    await waitFor(() =>
      expect(setParams).toHaveBeenCalledWith(
        expect.objectContaining({ sheet: "chat", question: "q_7", ping: "ntf_1" }),
      ),
    );
    expect(push).not.toHaveBeenCalled();
  });

  test("a canvas opened from a ping that the person can't open goes to the canvases with the line", async () => {
    backend.seed("pings");
    mockParams = { id: "cnv_gone", ping: "ntf_9" };
    await render(
      <App>
        <CanvasScreen />
      </App>,
    );
    await waitFor(() => expect(dismissTo).toHaveBeenCalledWith("/canvases"));
    expect(listNotice()).toBe("That canvas isn't available to you.");
  });
});
