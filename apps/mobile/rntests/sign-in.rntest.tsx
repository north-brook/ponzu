import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as WebBrowser from "expo-web-browser";
import { backend } from "../lib/cloud/backend.fake";
import SignIn from "../app/sign-in";

jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: jest.fn() }));
const openAuthSession = WebBrowser.openAuthSessionAsync as unknown as jest.Mock<
  (url: string, redirect: string) => Promise<{ type: string; url?: string }>
>;

/** What the fake's authorize page does: back to the app with `code` and the sign-in's state. */
const redirectWith = (code: string) => async (url: string, redirect: string) => {
  const state = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("state");
  return { type: "success", url: `${redirect}?code=${code}&state=${state}` };
};

// The page the fake signs in through, as Maestro's run has it, so the auth session opens.
(backend as { authorizeUrl: string | null }).authorizeUrl = "http://127.0.0.1:9/authorize";

beforeEach(() => {
  openAuthSession.mockReset();
  backend.seed("signed-out");
});

describe("sign in", () => {
  test("the screen: the title, the line, and Continue with GitHub", async () => {
    await render(<SignIn />);
    expect(screen.getByText("Sign in to Ponzu")).toBeTruthy();
    expect(
      screen.getByText(
        "Build on a canvas, steer with comments, and ship pull requests to your repos.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeTruthy();
    expect(screen.queryByTestId("sign-in-error")).toBeNull();
  });

  test("Continue opens the auth session on the app's own redirect, and signs in", async () => {
    openAuthSession.mockImplementation(redirectWith("fake"));
    await render(<SignIn />);
    await fireEvent.press(screen.getByRole("button", { name: "Continue with GitHub" }));
    await waitFor(() => expect(backend.session.getState().status).toBe("signed_in"));
    expect(openAuthSession).toHaveBeenCalledTimes(1);
    const [url, redirect] = openAuthSession.mock.calls[0]!;
    expect(redirect).toBe("ponzu://auth/callback");
    expect(url.startsWith("http://127.0.0.1:9/authorize?")).toBe(true);
  });

  test("while the sheet is up the button shows the turning slice, and a second tap opens nothing", async () => {
    let finish: (value: { type: string }) => void = () => {};
    openAuthSession.mockImplementation(
      () => new Promise((resolve) => (finish = resolve as typeof finish)),
    );
    await render(<SignIn />);
    const button = screen.getByRole("button", { name: "Continue with GitHub" });
    await fireEvent.press(button);
    expect(screen.getByTestId("sign-in-waiting")).toBeTruthy();
    await waitFor(() => expect(openAuthSession).toHaveBeenCalledTimes(1));
    await fireEvent.press(button);
    expect(openAuthSession).toHaveBeenCalledTimes(1);
    finish({ type: "cancel" });
    await waitFor(() => expect(screen.queryByTestId("sign-in-waiting")).toBeNull());
  });

  test("closing the sheet comes back with nothing said", async () => {
    openAuthSession.mockResolvedValue({ type: "cancel" });
    await render(<SignIn />);
    await fireEvent.press(screen.getByRole("button", { name: "Continue with GitHub" }));
    await waitFor(() => expect(openAuthSession).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("sign-in-waiting")).toBeNull());
    expect(screen.queryByTestId("sign-in-error")).toBeNull();
    expect(backend.session.getState().status).toBe("signed_out");
  });

  test("a sign-in that fails says so in one line above the button", async () => {
    openAuthSession.mockImplementation(redirectWith("not-the-code"));
    await render(<SignIn />);
    await fireEvent.press(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(await screen.findByText("Couldn't sign in. Try again.")).toBeTruthy();
    expect(backend.session.getState().status).toBe("signed_out");
  });

  test("when GitHub needs granting again, the screen says why", async () => {
    backend.seed("github-reauth");
    await render(<SignIn />);
    expect(screen.getByText("Sign in again so Ponzu can reach GitHub.")).toBeTruthy();
  });
});
