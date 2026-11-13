import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import * as WebBrowser from "expo-web-browser";
import * as ReactNative from "react-native";
import type { ToCanvas } from "../canvas/protocol";
import { backend, PR_SCENE, stockPullRequest } from "../lib/cloud/backend.fake";
import { CloudProvider } from "../lib/cloud/query";
import { drafts } from "../lib/drafts";
import { WindowInsetsProvider } from "../lib/window-insets";

/*
 * The pull request sheet on the canvas screen (components/pr-sheet.tsx), against the in-app
 * fake backend with GitHub played by the test (the client's FakePullRequests): what it shows,
 * its drill-ins, and its one action in each state, from Ready to a merge that asks first and
 * goes once.
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
const github = () => pricing().github!;
const maya = () => backend.world.fake.connect(backend.world.maya).api;
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

async function openSheet() {
  await fireEvent.press(await screen.findByTestId("stack-pr"));
  await screen.findByTestId("pr-sheet");
  await screen.findByTestId("pr-title");
}

/** The foot's button, once it says `label`. */
async function action(label: string) {
  await waitFor(() =>
    expect(within(screen.getByTestId("pr-action")).getByText(label)).toBeTruthy(),
  );
  return screen.getByTestId("pr-action");
}

/** The system's action sheet, held open until the test picks from it. */
function actionSheet() {
  return jest
    .spyOn(ReactNative.ActionSheetIOS, "showActionSheetWithOptions")
    .mockImplementation(() => {});
}

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

/** A pull request opened, ready, with a commit: the state each test then shapes. */
async function opened() {
  backend.world.fake.agent(pricing().id).push([{ path: "src/plans.tsx" }]);
  await maya().canvases.pullRequest.open(pricing().id);
  await maya().canvases.pullRequest.ready(pricing().id);
}

describe("the pull request sheet", () => {
  test("what it shows: the title, the branch, the description, Status and the files", async () => {
    await stockPullRequest(backend.world);
    const number = github().row.prNumber!;
    await openPricing();
    expect(screen.getByLabelText(`Pull request #${number}`)).toBeTruthy();
    await openSheet();
    expect(screen.getByTestId("pr-number").props.children).toBe(`#${number}`);
    expect(screen.getByTestId("pr-title").props.children).toBe("Pricing page");
    expect(screen.getByText(/→ main/)).toBeTruthy();
    expect(screen.getByText(PR_SCENE.description)).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("3 checks passed")).toBeTruthy();
    expect(screen.getByText("theo approved")).toBeTruthy();
    expect(screen.getByText("2 comments")).toBeTruthy();
    expect(screen.getByText("3 files")).toBeTruthy();
    expect(screen.getAllByTestId("pr-file")).toHaveLength(3);
    // No "Ready to merge" anywhere: the one button says what it does.
    expect(screen.queryByText(/Ready to merge/)).toBeNull();
    const merge = await action("Merge");
    expect(merge.props.accessibilityState).toMatchObject({ disabled: false });
    // VoiceOver hears which pull request it merges.
    expect(merge.props.accessibilityLabel).toBe(`Merge #${number}`);

    // Open on GitHub leaves for the pull request's own page.
    await fireEvent.press(screen.getByTestId("pr-open-github"));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(
      `https://github.com/acme/site/pull/${number}`,
    );
  });

  test("the drill-ins: every check, the reviews, the conversation, and a file's diff", async () => {
    await stockPullRequest(backend.world);
    await openPricing();
    await openSheet();

    await fireEvent.press(screen.getByTestId("pr-checks"));
    expect(await screen.findByTestId("pr-drill-checks")).toBeTruthy();
    expect(screen.getAllByTestId("pr-check")).toHaveLength(PR_SCENE.checks.length);
    for (const name of PR_SCENE.checks) expect(screen.getByText(name)).toBeTruthy();
    // No action at the foot inside a drill-in.
    expect(screen.queryByTestId("pr-action")).toBeNull();
    await fireEvent.press(screen.getByTestId("pr-back"));

    await fireEvent.press(await screen.findByTestId("pr-reviews"));
    expect(await screen.findByTestId("pr-drill-reviews")).toBeTruthy();
    expect(screen.getAllByTestId("pr-review")).toHaveLength(1);
    await fireEvent.press(screen.getByTestId("pr-back"));

    await fireEvent.press(await screen.findByTestId("pr-comments"));
    const talk = await screen.findByTestId("pr-drill-conversation");
    expect(within(talk).getByText(PR_SCENE.comments[0]!.body)).toBeTruthy();
    expect(within(talk).getByText(PR_SCENE.comments[1]!.body)).toBeTruthy();
    // Maya's own comment reads as hers; there is no field to reply in.
    expect(within(talk).getByText("You")).toBeTruthy();
    expect(screen.queryByTestId("chat-input")).toBeNull();
    await fireEvent.press(screen.getByTestId("pr-back"));

    await fireEvent.press((await screen.findAllByLabelText("src/components/plans.tsx"))[0]!);
    expect(await screen.findByTestId("pr-diff")).toBeTruthy();
    expect(await screen.findByLabelText(/^Added: .*PlanRow/)).toBeTruthy();
    expect(screen.getByLabelText(/^Removed: .*Plan name="Pro"/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("pr-back"));

    await fireEvent.press((await screen.findAllByLabelText("public/plans.png"))[0]!);
    expect(await screen.findByTestId("pr-diff-none")).toBeTruthy();
    expect(screen.getByText("A binary file. GitHub shows what changed.")).toBeTruthy();
  });

  test("Merge asks first, merges once with the commit shown, and the button goes", async () => {
    await stockPullRequest(backend.world);
    const { prNumber } = github().row;
    const headSha = (await maya().canvases.pullRequest.get(pricing().id)).pullRequest!.head.sha;
    const merge = jest.spyOn(backend.api.canvases.pullRequest, "merge");
    const sheet = actionSheet();
    await openPricing();
    await openSheet();
    const button = await action("Merge");
    // A double tap: the question asks once.
    await fireEvent.press(button);
    await fireEvent.press(button);
    expect(sheet).toHaveBeenCalledTimes(1);
    const [options, pick] = sheet.mock.calls[0] as [
      { title?: string; options: string[]; cancelButtonIndex?: number },
      (index: number) => void,
    ];
    expect(options).toMatchObject({
      title: `Merge #${prNumber} into main?`,
      options: ["Merge", "Cancel"],
      cancelButtonIndex: 1,
    });
    // While it asks, and while GitHub answers, the label stays and the button holds still.
    expect(screen.getByTestId("pr-action").props.accessibilityState).toMatchObject({
      disabled: true,
      busy: true,
    });
    await act(async () => pick(0));
    await waitFor(() => expect(screen.queryByTestId("pr-action")).toBeNull());
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith(pricing().id, { headSha });
    expect(github().row.prState).toBe("merged");
    expect(screen.getByText(/^· Merged/)).toBeTruthy();
  });

  test("Cancel merges nothing, and the button is back", async () => {
    await stockPullRequest(backend.world);
    const merge = jest.spyOn(backend.api.canvases.pullRequest, "merge");
    const sheet = actionSheet();
    await openPricing();
    await openSheet();
    await fireEvent.press(await action("Merge"));
    const [, pick] = sheet.mock.calls[0] as [object, (index: number) => void];
    await act(async () => pick(1));
    expect(merge).not.toHaveBeenCalled();
    expect(screen.getByTestId("pr-action").props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  test("a push while it asks: GitHub's reason above the button, and nothing merged", async () => {
    await stockPullRequest(backend.world);
    const sheet = actionSheet();
    await openPricing();
    await openSheet();
    await fireEvent.press(await action("Merge"));
    const [, pick] = sheet.mock.calls[0] as [object, (index: number) => void];
    await act(async () => {
      github().push([{ path: "src/faq.tsx" }]);
    });
    await act(async () => pick(0));
    expect(await screen.findByTestId("pr-failed")).toBeTruthy();
    expect(
      screen.getByText("The branch has new commits since you looked. Look again first."),
    ).toBeTruthy();
    expect(github().row.prState).toBe("open");
  });

  test("a draft: Ready, then what follows from the checks", async () => {
    backend.world.fake.agent(pricing().id).push();
    await maya().canvases.pullRequest.open(pricing().id);
    await openPricing();
    await openSheet();
    expect(screen.getByText(/^· Draft/)).toBeTruthy();
    await fireEvent.press(await action("Ready"));
    // Ready, with no checks and nothing the rules want: Merge.
    expect(await action("Merge")).toBeTruthy();
    expect(github().row.prState).toBe("open");
  });

  test("checks running: Auto-merge, then it waits on GitHub and says so", async () => {
    await opened();
    github().setChecks([{ name: "ci / test", state: "running", required: true }]);
    await openPricing();
    await openSheet();
    expect(screen.getByText("0 of 1 checks finished")).toBeTruthy();
    await fireEvent.press(await action("Auto-merge"));
    const on = await action("Auto-merge on");
    expect(on.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText("Merges once the checks pass")).toBeTruthy();
  });

  test("a check failed: Fix checks asks Claude in the chat, once for the commit", async () => {
    await opened();
    github().setChecks([{ name: "ci / visual", state: "failed" }]);
    const send = jest.spyOn(backend.api.canvases, "sendMessage");
    await openPricing();
    await openSheet();
    expect(screen.getByText("1 check failed")).toBeTruthy();
    await fireEvent.press(await action("Fix checks"));
    await waitFor(() => expect(screen.getByText("Asked Claude in the chat.")).toBeTruthy());
    expect(send).toHaveBeenCalledWith(pricing().id, {
      text: "Fix the failing checks on the pull request (ci / visual) and push.",
    });
    expect(screen.getByTestId("pr-action").props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.press(screen.getByTestId("pr-action"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("conflicts: Resolve asks Claude to merge the base in", async () => {
    await opened();
    github().baseChanged({ conflicts: true });
    const send = jest.spyOn(backend.api.canvases, "sendMessage");
    await openPricing();
    await openSheet();
    await fireEvent.press(await action("Resolve"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(pricing().id, {
        text: "The branch conflicts with main. Merge main in, resolve the conflicts and push.",
      }),
    );
  });

  test("held back by the repo's rules with no auto-merge: the line, and nothing to press", async () => {
    await opened();
    github().autoMergeAllowed = false;
    github().protect({ review: true });
    await openPricing();
    await openSheet();
    expect(
      await screen.findByText("This needs the Mac to merge past the review the repo's rules want."),
    ).toBeTruthy();
    expect(screen.queryByTestId("pr-action")).toBeNull();
  });

  test("the sheet follows GitHub: a teammate's merge elsewhere takes the button away", async () => {
    await stockPullRequest(backend.world);
    await openPricing();
    await openSheet();
    await action("Merge");
    const headSha = (await maya().canvases.pullRequest.get(pricing().id)).pullRequest!.head.sha;
    await act(async () => {
      const sam = backend.world.fake.connect(backend.world.maya).api;
      await sam.canvases.pullRequest.merge(pricing().id, { headSha });
    });
    await waitFor(() => expect(screen.queryByTestId("pr-action")).toBeNull());
  });

  test("Fix checks stays asked for the commit when the sheet is closed and opened again", async () => {
    await opened();
    github().setChecks([{ name: "ci / visual", state: "failed" }]);
    const send = jest.spyOn(backend.api.canvases, "sendMessage");
    await openPricing();
    await openSheet();
    await fireEvent.press(await action("Fix checks"));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByTestId("pr-close"));
    await waitFor(() => expect(screen.queryByTestId("pr-sheet")).toBeNull());
    await openSheet();
    expect(await screen.findByText("Asked Claude in the chat.")).toBeTruthy();
    expect((await action("Fix checks")).props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.press(screen.getByTestId("pr-action"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("an answer kept from before a merge elsewhere offers no Merge until GitHub is read again", async () => {
    await stockPullRequest(backend.world);
    await openPricing();
    await openSheet();
    await action("Merge");
    await fireEvent.press(screen.getByTestId("pr-close"));
    await waitFor(() => expect(screen.queryByTestId("pr-sheet")).toBeNull());
    const headSha = (await maya().canvases.pullRequest.get(pricing().id)).pullRequest!.head.sha;
    // GitHub is slow to answer from here on: the sheet has only the answer it kept.
    jest
      .spyOn(backend.api.canvases.pullRequest, "get")
      .mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      await maya().canvases.pullRequest.merge(pricing().id, { headSha });
    });
    expect(github().row.prState).toBe("merged");
    await openSheet();
    await waitFor(() => expect(screen.queryByTestId("pr-action")).toBeNull());
  });

  test("opened by a link (sheet=pull-request): up at once", async () => {
    await stockPullRequest(backend.world);
    await openPricing({ sheet: "pull-request" });
    expect(await screen.findByTestId("pr-sheet")).toBeTruthy();
    expect(await screen.findByText("3 checks passed")).toBeTruthy();
  });

  test("a pull request's line in the chat opens the sheet, and the chat is read", async () => {
    await stockPullRequest(backend.world);
    const seen = jest.spyOn(backend.api.canvases, "seen");
    await openPricing();
    await fireEvent.press(await screen.findByTestId("stack-chat"));
    await screen.findByTestId("chat-sheet");
    const lines = await screen.findAllByTestId("chat-pull-request");
    seen.mockClear();
    await fireEvent.press(lines[0]!);
    expect(await screen.findByTestId("pr-sheet")).toBeTruthy();
    expect(screen.queryByTestId("chat-sheet")).toBeNull();
    expect(seen).toHaveBeenCalledWith(
      pricing().id,
      expect.objectContaining({ threadSeq: expect.any(Number) }),
    );
  });

  test("Close goes back to the canvas, its stack again", async () => {
    await stockPullRequest(backend.world);
    await openPricing();
    await openSheet();
    await fireEvent.press(screen.getByTestId("pr-close"));
    await waitFor(() => expect(screen.queryByTestId("pr-sheet")).toBeNull());
    expect(screen.getByTestId("stack-pr")).toBeTruthy();
  });
});
