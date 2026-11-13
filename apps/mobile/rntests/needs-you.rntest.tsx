import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ToCanvas } from "../canvas/protocol";
import { ASKS_SCENE, backend, stockAsks } from "../lib/cloud/backend.fake";
import { CloudProvider } from "../lib/cloud/query";
import { drafts } from "../lib/drafts";
import { WindowInsetsProvider } from "../lib/window-insets";

/*
 * Needs you (components/needs-you.tsx) in the chat sheet on the canvas screen, against the
 * in-app fake backend: each kind of ask, the pager, a multi-select, a teammate's answer, a 409,
 * an answer sent once, a push's question, and a canvas the person may only look at.
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

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  ...(jest.requireActual("expo-router") as object),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ setOptions: () => {} }),
  useIsFocused: () => true,
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));

const CanvasScreen = require("../app/canvas/[id]").default as () => React.JSX.Element;

const pricing = () =>
  [...backend.world.fake.canvases.values()].find(
    (c) => c.repoId === backend.world.acme.repos[0]!.id,
  )!;
const agent = () => backend.world.fake.agent(pricing().id);
const question = (id: string) => pricing().questions.find((q) => q.id === id)!;
const sent = (kind: ToCanvas["t"]) => mockPage.got.filter((m) => m.t === kind);

const BLUE = {
  kind: "question" as const,
  payload: {
    questions: [
      {
        header: "Button colour",
        question: "Which blue for the buttons?",
        options: [
          { label: "Royal", description: "The brand's own" },
          { label: "Sky", description: "" },
        ],
        multiSelect: false,
      },
    ],
  },
};

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

const choose = (label: string | RegExp) =>
  act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
const send = () =>
  act(async () => {
    fireEvent.press(screen.getByTestId("needs-you-send"));
  });
const header = () => screen.getByTestId("needs-you-header").props.children;

beforeEach(async () => {
  mockPage.got = [];
  mockPage.say = null;
  drafts.clear();
  await AsyncStorage.clear();
  backend.reset();
  await backend.prepare();
  backend.seed("signed-in");
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("needs you", () => {
  test("one question: no pager; in the composer's place until it is answered", async () => {
    const id = agent().ask(BLUE, "Button colour");
    await openPricing();
    // Chat wears the count before it is opened.
    expect(await screen.findByLabelText("Chat, Ponzu has a question")).toBeTruthy();
    await openChat();
    expect(await screen.findByTestId("needs-you")).toBeTruthy();
    expect(header()).toBe("Button colour");
    expect(screen.getByText("Which blue for the buttons?")).toBeTruthy();
    expect(screen.queryByTestId("needs-you-pager")).toBeNull();
    expect(screen.queryByTestId("chat-input")).toBeNull();
    // Nothing chosen, nothing to send.
    expect(screen.getByTestId("needs-you-send").props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await choose(/^Sky/);
    expect(screen.getByLabelText(/^Sky/).props.accessibilityState).toMatchObject({
      checked: true,
    });
    await send();
    await waitFor(() => expect(question(id).status).toBe("answered"));
    expect(question(id).answer?.body).toEqual({
      answers: { "Which blue for the buttons?": "Sky" },
    });
    // Answered: its row goes and the composer is back.
    await waitFor(() => expect(screen.queryByTestId("needs-you")).toBeNull());
    expect(screen.getByTestId("chat-input")).toBeTruthy();
  });

  test("several: the pager, a multi-select, a plan and a permission, each sent as the API takes it", async () => {
    const [ask, plan, permission] = await stockAsks(backend.world);
    await openPricing();
    await openChat();
    await screen.findByTestId("needs-you");
    expect(screen.getByLabelText("1 of 4")).toBeTruthy();
    expect(screen.getByTestId("needs-you-previous").props.accessibilityState).toMatchObject({
      disabled: true,
    });
    // The first page of the two-question ask; Send moves to its second, sending nothing yet.
    await choose("Royal");
    await send();
    expect(header()).toBe("Sections");
    expect(screen.getByLabelText("2 of 4")).toBeTruthy();
    expect(question(ask!).status).toBe("open");
    expect(screen.getByText("Choose any.", { exact: false })).toBeTruthy();
    // Several raised rows, and a note with them.
    await choose("Comparison table");
    await choose("FAQ");
    expect(screen.getByLabelText("FAQ").props.accessibilityState).toMatchObject({ checked: true });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId("needs-you-note"), "Keep it short");
    });
    await send();
    await waitFor(() => expect(question(ask!).status).toBe("answered"));
    expect(question(ask!).answer?.body).toEqual({
      answers: {
        [ASKS_SCENE.blue.question]: "Royal",
        // In the options' order, then the note.
        [ASKS_SCENE.sections.question]: "FAQ, Comparison table. Keep it short",
      },
    });
    // On to the plan: its first paragraph, and the rest when asked for.
    await waitFor(() => expect(header()).toBe("Plan"));
    expect(screen.getByText(ASKS_SCENE.planFirst)).toBeTruthy();
    expect(screen.queryByText(ASKS_SCENE.planRest)).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByText("Read the plan"));
    });
    expect(screen.getByText(ASKS_SCENE.planRest)).toBeTruthy();
    await choose(/^Approve/);
    await send();
    await waitFor(() => expect(question(plan!).answer?.body).toEqual({ approved: true }));
    // The permission: its title as the question, Allow or Deny, a note with it.
    await waitFor(() => expect(header()).toBe("Permission"));
    expect(screen.getByText(ASKS_SCENE.permission.title)).toBeTruthy();
    expect(screen.queryByTestId("needs-you-pager")).toBeNull();
    await choose("Deny");
    await act(async () => {
      fireEvent.changeText(screen.getByTestId("needs-you-note"), "Not on main");
    });
    await send();
    await waitFor(() =>
      expect(question(permission!).answer?.body).toEqual({ approved: false, note: "Not on main" }),
    );
    await waitFor(() => expect(screen.queryByTestId("needs-you")).toBeNull());
  });

  test("a note alone answers a question, in the person's words", async () => {
    const id = agent().ask(BLUE, "Button colour");
    await openPricing({ sheet: "chat" });
    await screen.findByTestId("needs-you");
    await act(async () => {
      fireEvent.changeText(screen.getByTestId("needs-you-note"), "Whatever matches the logo");
    });
    await send();
    await waitFor(() =>
      expect(question(id).answer?.body).toEqual({
        answers: { "Which blue for the buttons?": "Whatever matches the logo" },
      }),
    );
  });

  test("Send pressed twice answers once", async () => {
    const id = agent().ask(BLUE, "Button colour");
    await openPricing({ sheet: "chat" });
    await screen.findByTestId("needs-you");
    const answer = jest.spyOn(backend.api.canvases, "answer");
    await choose("Royal, The brand's own");
    await act(async () => {
      fireEvent.press(screen.getByTestId("needs-you-send"));
      fireEvent.press(screen.getByTestId("needs-you-send"));
    });
    await waitFor(() => expect(question(id).status).toBe("answered"));
    expect(answer).toHaveBeenCalledTimes(1);
  });

  test("a teammate answering elsewhere takes it away here", async () => {
    const id = agent().ask(BLUE, "Button colour");
    await openPricing({ sheet: "chat" });
    await screen.findByTestId("needs-you");
    const { fake, acme } = backend.world;
    const sam = fake.addPerson({ login: "samr", name: "Sam Reed" });
    fake.workspaces.get(acme.id)!.members.set(sam.id, "member");
    await act(async () => {
      await fake.connect(sam).api.canvases.answer(pricing().id, id, {
        answers: { "Which blue for the buttons?": "Sky" },
      });
    });
    await waitFor(() => expect(screen.queryByTestId("needs-you")).toBeNull());
    expect(screen.getByTestId("chat-input")).toBeTruthy();
  });

  test("a 409: someone already answered it, and the next one shows", async () => {
    const id = agent().ask(BLUE, "Button colour");
    agent().ask({ kind: "plan", payload: { plan: "Three plans." } }, "Plan");
    await openPricing({ sheet: "chat" });
    await screen.findByTestId("needs-you");
    // Someone's answer gets there first, while the person's is on its way.
    const { fake, acme } = backend.world;
    const sam = fake.addPerson({ login: "samr", name: "Sam Reed" });
    fake.workspaces.get(acme.id)!.members.set(sam.id, "member");
    const real = backend.api.canvases.answer;
    jest.spyOn(backend.api.canvases, "answer").mockImplementationOnce(async (...args) => {
      await fake.connect(sam).api.canvases.answer(pricing().id, id, {
        answers: { "Which blue for the buttons?": "Sky" },
      });
      return real(...args);
    });
    await choose(/^Royal/);
    await send();
    expect(await screen.findByText("Sam already answered this.")).toBeTruthy();
    await waitFor(() => expect(header()).toBe("Plan"));
    expect(question(id).answer?.userId).toBe(sam.id);
  });

  test("opened by a push's question: that one shows first", async () => {
    const [, plan] = await stockAsks(backend.world);
    await openPricing({ sheet: "chat", question: plan! });
    await screen.findByTestId("needs-you");
    expect(header()).toBe("Plan");
    expect(screen.getByLabelText("3 of 4")).toBeTruthy();
  });

  test("a later push's question, with the card already up, turns to it", async () => {
    const [, plan, permission] = await stockAsks(backend.world);
    await openPricing({ sheet: "chat", question: plan! });
    await screen.findByTestId("needs-you");
    expect(header()).toBe("Plan");
    mockParams = { ...mockParams, question: permission! };
    await act(async () => {
      screen.rerender(
        <WindowInsetsProvider>
          <CloudProvider>
            <CanvasScreen />
          </CloudProvider>
        </WindowInsetsProvider>,
      );
    });
    await waitFor(() => expect(header()).toBe("Permission"));
    expect(screen.getByLabelText("4 of 4")).toBeTruthy();
  });

  test("a secret: a secure field, sent by its own route and never as an answer", async () => {
    agent().ask({ kind: "secret", payload: { name: "STRIPE_KEY", description: null } }, "Secret");
    await openPricing({ sheet: "chat" });
    await screen.findByTestId("needs-you");
    expect(header()).toBe("Secret");
    const answer = jest.spyOn(backend.api.canvases, "answer");
    const answerSecret = jest.spyOn(backend.api.canvases, "answerSecret");
    const field = screen.getByLabelText("The value of STRIPE_KEY");
    expect(field.props.secureTextEntry).toBe(true);
    await act(async () => {
      fireEvent.changeText(field, "sk_test_123");
    });
    await send();
    await waitFor(() => expect(answerSecret).toHaveBeenCalledTimes(1));
    expect(answerSecret.mock.calls[0]!.slice(2)).toEqual(["sk_test_123"]);
    expect(answer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("needs-you")).toBeNull());
    expect(screen.queryByText("sk_test_123")).toBeNull();
  });

  test("on a canvas the person may only read: the ask shows, and can't be answered", async () => {
    agent().ask(BLUE, "Button colour");
    const repo = backend.world.fake.workspaces.get(backend.world.acme.id)!.repos[0]!;
    repo.access.set(backend.world.maya.id, "read");
    await openPricing({ sheet: "chat" });
    await screen.findByTestId("needs-you");
    expect(screen.getByTestId("needs-you-blocked")).toBeTruthy();
    expect(
      screen.getByText("You can look at this canvas. Steering it takes push access to acme/site."),
    ).toBeTruthy();
    expect(screen.queryByTestId("needs-you-send")).toBeNull();
    expect(screen.getByLabelText(/^Royal/).props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});
