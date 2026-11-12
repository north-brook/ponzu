import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams, useSegments } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import type { ReactNode } from "react";
import { Linking } from "react-native";
import ConnectClaude from "../app/setup/claude";
import PasteCode from "../app/setup/code";
import Where from "../app/setup/where";
import { backend } from "../lib/cloud/backend.fake";
import { CloudProvider } from "../lib/cloud/query";
import { useGate } from "../lib/cloud/use-gate";

jest.mock("expo-web-browser", () => ({
  openAuthSessionAsync: jest.fn(),
  dismissAuthSession: jest.fn(),
}));
type AuthResult = { type: string; url?: string };
const openAuthSession = WebBrowser.openAuthSessionAsync as unknown as jest.Mock<
  (url: string, redirect: string) => Promise<AuthResult>
>;
const dismissAuthSession = WebBrowser.dismissAuthSession as unknown as jest.Mock<() => void>;
const replace = router.replace as unknown as jest.Mock;
const push = router.push as unknown as jest.Mock;
const segments = useSegments as unknown as jest.Mock<() => string[]>;
const params = useLocalSearchParams as unknown as jest.Mock<() => Record<string, string>>;
const openURL = jest.spyOn(Linking, "openURL");

/** The app's gate, on the screen `at` names: where it sends the app is `router.replace`'s. */
function Gate() {
  useGate();
  return null;
}

async function show(screenNode: ReactNode, at: string[]) {
  segments.mockReturnValue(at);
  await render(
    <CloudProvider>
      <Gate />
      {screenNode}
    </CloudProvider>,
  );
}

/** The auth session's sheet, held open until the test (or a dismiss) closes it. */
function holdSheet() {
  let close: (result: AuthResult) => void = () => {};
  openAuthSession.mockImplementation(
    () =>
      new Promise((done) => {
        close = done;
      }),
  );
  dismissAuthSession.mockImplementation(() => close({ type: "dismiss" }));
  return { close: (result: AuthResult) => close(result) };
}

beforeEach(async () => {
  backend.reset();
  replace.mockClear();
  push.mockClear();
  openURL.mockReset();
  openURL.mockResolvedValue(undefined);
  openAuthSession.mockReset();
  dismissAuthSession.mockReset();
  params.mockReturnValue({});
  (global as { clipboard?: string }).clipboard = undefined;
  await AsyncStorage.clear();
  await backend.prepare();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("where do you build", () => {
  test("nothing ready: the person's own account with Set up, and Continue waits", async () => {
    backend.seed("setup-where");
    await show(<Where />, ["setup", "where"]);
    expect(await screen.findByText("Personal")).toBeTruthy();
    expect(screen.getByText("Where do you build?")).toBeTruthy();
    expect(screen.getByText("lee")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up Personal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  test("one ready: Continue records the step, and the gate goes on to Connect Claude", async () => {
    backend.world.fake.install(backend.world.leeAccount.id);
    backend.seed("setup-where");
    await show(<Where />, ["setup", "where"]);
    expect(await screen.findByLabelText("Personal, Ready")).toBeTruthy();
    const next = screen.getByRole("button", { name: "Continue" });
    await waitFor(() => expect(next).toBeEnabled());
    await fireEvent.press(next);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/setup/claude"));
    expect(backend.world.fake.onboarding.get(backend.world.lee.id)?.whereAt).not.toBeNull();
  });

  test("Set up opens GitHub's page in the auth session, and the setup link brings back Ready", async () => {
    backend.seed("setup-where");
    await show(<Where />, ["setup", "where"]);
    const sheet = holdSheet();
    await fireEvent.press(await screen.findByRole("button", { name: "Set up Personal" }));
    await waitFor(() => expect(openAuthSession).toHaveBeenCalledTimes(1));
    const [url, redirect] = openAuthSession.mock.calls[0]!;
    expect(url).toBe("https://github.com/apps/ponzu-dev/installations/new?state=fake");
    expect(redirect).toBe("ponzu://github/setup");
    // While it is open the row waits, and nothing else can be set up.
    expect(screen.getByRole("button", { name: "Set up Personal" })).toBeBusy();
    expect(
      screen.getByRole("button", { name: "Don't see an organization? Grant access on GitHub ↗" }),
    ).toBeDisabled();
    await act(async () => {
      sheet.close({
        type: "success",
        url: `ponzu://github/setup?result=installed&workspace=${backend.world.leeAccount.id}`,
      });
    });
    expect(await screen.findByLabelText("Personal, Ready")).toBeTruthy();
    expect(dismissAuthSession).not.toHaveBeenCalled();
    // The workspace just set up is the one the canvases open on.
    expect(await AsyncStorage.getItem(`ponzu.workspace.${backend.world.lee.id}`)).toBe(
      backend.world.leeAccount.id,
    );
  });

  test("the install settles through the poll: the sheet is closed for the person", async () => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick", "setImmediate"] });
    backend.seed("setup-where");
    await show(<Where />, ["setup", "where"]);
    holdSheet();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    await fireEvent.press(screen.getByRole("button", { name: "Set up Personal" }));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });
    expect(dismissAuthSession).not.toHaveBeenCalled();
    // GitHub finishes; the next question hears it.
    backend.settleInstalls("installed");
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });
    expect(dismissAuthSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByLabelText("Personal, Ready")).toBeTruthy();
  });

  test("asked of an organization's owners: says so under the accounts", async () => {
    backend.seed("setup-where");
    await show(<Where />, ["setup", "where"]);
    openAuthSession.mockResolvedValue({
      type: "success",
      url: "ponzu://github/setup?result=requested",
    });
    await fireEvent.press(
      await screen.findByRole("button", {
        name: "Don't see an organization? Grant access on GitHub ↗",
      }),
    );
    expect(
      await screen.findByText(
        "Sent to the organization's owners. It shows up here once one approves.",
      ),
    ).toBeTruthy();
    // GitHub's own page, for an organization the list can't show: no account suggested.
    expect(openAuthSession).toHaveBeenCalledTimes(1);
  });

  test("closing the sheet early still asks GitHub, so an install done before it shows", async () => {
    backend.seed("setup-where");
    await show(<Where />, ["setup", "where"]);
    openAuthSession.mockResolvedValue({ type: "cancel" });
    await fireEvent.press(await screen.findByRole("button", { name: "Set up Personal" }));
    // The fake's install page was opened, so GitHub's next sync finds it installed.
    expect(await screen.findByLabelText("Personal, Ready")).toBeTruthy();
    expect(screen.queryByTestId("setup-where-notice")).toBeNull();
  });
});

describe("connect Claude", () => {
  test("the two ways, in the Mac's words", async () => {
    backend.seed("setup-claude");
    await show(<ConnectClaude />, ["setup", "claude"]);
    expect(screen.getByText("Connect Claude")).toBeTruthy();
    expect(screen.getByText("Claude Subscription")).toBeTruthy();
    expect(screen.getByText("Pro or Max. Canvases run on your plan.")).toBeTruthy();
    expect(screen.getByText("Anthropic API key")).toBeTruthy();
    expect(screen.getByText("Pay per token through the Console.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  test("Sign in starts a claude.ai sign-in, goes to the code screen, and opens Safari", async () => {
    backend.seed("setup-claude");
    await show(<ConnectClaude />, ["setup", "claude"]);
    await fireEvent.press(screen.getByRole("button", { name: "Sign in to Claude Subscription" }));
    await waitFor(() => expect(openURL).toHaveBeenCalledTimes(1));
    const [url] = openURL.mock.calls[0]!;
    expect(url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);
    expect(push).toHaveBeenCalledTimes(1);
    const [to] = push.mock.calls[0] as [{ pathname: string; params: Record<string, string> }];
    expect(to.pathname).toBe("/setup/code");
    expect(to.params.signIn).toMatch(/^csi_/);
    expect(backend.world.fake.claude.openSignIns(backend.world.ava.id)).toBe(1);
  });

  test("too many sign-ins this hour says so", async () => {
    backend.world.fake.claude.limited = true;
    backend.seed("setup-claude");
    await show(<ConnectClaude />, ["setup", "claude"]);
    await fireEvent.press(screen.getByRole("button", { name: "Sign in to Claude Subscription" }));
    expect(
      await screen.findByText(
        "You've started signing in to Claude several times this hour. Try again later.",
      ),
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  test("a key Anthropic turns away says so; a good one connects and the gate moves on", async () => {
    let good = false;
    backend.world.fake.claude.acceptsKey = () => good;
    backend.seed("setup-claude");
    await show(<ConnectClaude />, ["setup", "claude"]);
    await fireEvent.press(screen.getByRole("button", { name: "Add key: Anthropic API key" }));
    const field = screen.getByLabelText("Paste your Anthropic API key");
    expect(
      screen.getByText(
        "Usage bills to your Anthropic Console account. Ponzu stores the key encrypted.",
      ),
    ).toBeTruthy();
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();
    // A copy's stray spaces and line breaks go.
    await fireEvent.changeText(field, " sk-ant-test\n");
    expect(field.props.value).toBe("sk-ant-test");
    await fireEvent.press(connect);
    expect(await screen.findByText("Anthropic didn't accept that key.")).toBeTruthy();
    good = true;
    await fireEvent.changeText(field, "sk-ant-good");
    expect(screen.queryByText("Anthropic didn't accept that key.")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/canvases"));
  });
});

describe("paste the code", () => {
  /** A sign-in started on Connect Claude, as its push hands it to the code screen. */
  async function codeScreen() {
    backend.seed("setup-claude");
    const started = await backend.api.claude.startSignIn();
    params.mockReturnValue({ signIn: started.id, expiresAt: started.expiresAt });
    await show(<PasteCode />, ["setup", "code"]);
    return started;
  }

  test("the paste control lifts the code out of what was copied, and Connect connects", async () => {
    await codeScreen();
    expect(screen.getByText("claude.ai shows it after you approve.")).toBeTruthy();
    (global as { clipboard?: string }).clipboard = "Paste this code: k7Q2-x#s9Df into Ponzu";
    await fireEvent.press(screen.getByRole("button", { name: "Paste" }));
    expect(screen.getByLabelText("Paste the code from claude.ai").props.value).toBe("k7Q2-x#s9Df");
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/canvases"));
  });

  test("half a code can be pasted again; a wrong one needs a new sign-in", async () => {
    backend.world.fake.claude.acceptsCode = () => false;
    await codeScreen();
    const field = screen.getByLabelText("Paste the code from claude.ai");
    await fireEvent.changeText(field, "k7Q2");
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("That code isn't complete. Copy all of it.")).toBeTruthy();
    await fireEvent.changeText(field, "k7Q2#s9");
    await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("That code didn't work.")).toBeTruthy();
    // Spent: typing doesn't help, only Open sign-in again.
    await fireEvent.changeText(field, "other#code");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    openURL.mockClear();
    await fireEvent.press(screen.getByRole("link", { name: "Open sign-in again" }));
    await waitFor(() => expect(openURL).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("claude.ai shows it after you approve.")).toBeTruthy();
    expect(screen.getByLabelText("Paste the code from claude.ai").props.value).toBe("");
  });

  test("ten minutes on, the code has expired before anyone tries it", async () => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick", "setImmediate"] });
    await codeScreen();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10 * 60_000 + 1);
    });
    expect(screen.getByText("That code has expired.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  test("Change lets the sign-in go and goes back", async () => {
    await codeScreen();
    const ava = backend.world.ava.id;
    expect(backend.world.fake.claude.openSignIns(ava)).toBe(1);
    await fireEvent.press(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(backend.world.fake.claude.openSignIns(ava)).toBe(0));
    expect(replace).toHaveBeenCalledWith("/setup/claude");
  });

  test("Claude connected on another device moves on by itself", async () => {
    await codeScreen();
    expect(replace).not.toHaveBeenCalled();
    // The Mac, as Ava, connects a key: the live `me` row says so here.
    const mac = backend.world.fake.connect(backend.world.ava);
    await act(async () => {
      await mac.api.claude.connectApiKey("sk-ant-from-the-mac");
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/canvases"));
  });
});
