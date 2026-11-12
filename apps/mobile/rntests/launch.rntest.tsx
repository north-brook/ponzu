import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { SessionState } from "@ponzu/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { onlineManager } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import Launch from "../app/index";
import { backend } from "../lib/cloud/backend.fake";
import { CloudProvider } from "../lib/cloud/query";

const replace = router.replace as unknown as jest.Mock;
/** The fake session's own setter, for a state no scenario names (still reading the Keychain). */
const setState = (state: SessionState) =>
  (backend.session as unknown as { set(state: SessionState): void }).set(state);

/**
 * Move the clock on by `ms`, a tenth of a second at a time, so what each answer sets going
 * (the fake's answers take a moment, as the API's do) runs on the same clock.
 */
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 100) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(Math.min(100, left));
    });
  }
}

/** The launch screen, on a clock the test moves. */
async function launch(ms: number) {
  await render(
    <CloudProvider>
      <Launch />
    </CloudProvider>,
  );
  await advance(ms);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.useFakeTimers();
  replace.mockClear();
});
afterEach(() => {
  onlineManager.setOnline(true);
  jest.useRealTimers();
});

describe("launch goes where the session says", () => {
  const cases: [string, string][] = [
    ["signed-out", "/sign-in"],
    ["github-reauth", "/sign-in"],
    ["too-old", "/update"],
    ["signed-in", "/canvases"],
    // Signed in, setup's next step comes first.
    ["setup-where", "/setup/where"],
    ["setup-claude", "/setup/claude"],
  ];
  for (const [scenario, route] of cases) {
    test(`${scenario} → ${route}`, async () => {
      backend.seed(scenario);
      await launch(3_000);
      expect(replace.mock.calls).toEqual([[route]]);
    });
  }

  test("never before the bloom has landed", async () => {
    backend.seed("signed-out");
    await launch(300);
    expect(replace).not.toHaveBeenCalled();
    await advance(2_000);
    expect(replace.mock.calls).toEqual([["/sign-in"]]);
  });

  test("while the session is still being read it stays, and says so after 8 seconds", async () => {
    setState({ status: "loading" });
    await launch(7_000);
    expect(screen.queryByText("Can't reach Ponzu. Trying again.")).toBeNull();
    await advance(1_500);
    expect(screen.getByText("Can't reach Ponzu. Trying again.")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    // Then the session answers, and the launch goes on.
    await act(async () => {
      backend.seed("signed-in");
    });
    await advance(3_000);
    expect(replace.mock.calls).toEqual([["/canvases"]]);
  });

  test("offline, once the Keychain is read: setup's step comes from the copy on disk", async () => {
    // A launch online leaves Ava's `me` on disk, with Claude still to connect.
    backend.seed("setup-claude");
    await launch(3_000);
    expect(replace.mock.calls).toEqual([["/setup/claude"]]);
    await advance(3_000);
    screen.unmount();
    expect(await AsyncStorage.getItem("ponzu.queries")).toBeTruthy();
    replace.mockClear();
    // The next launch is offline, and the session is read from the Keychain after it mounts,
    // as on the phone: the launch must read `me` on Ava's client, which holds the copy. (On a
    // fake clock that moves with the real one: the copy is read back through promises a still
    // fake clock does not move, and leaving fake timers for real ones mid-test left the shared
    // cleanup after it waiting for good on CI.)
    jest.useFakeTimers({ advanceTimers: true });
    onlineManager.setOnline(false);
    setState({ status: "loading" });
    await render(
      <CloudProvider>
        <Launch />
      </CloudProvider>,
    );
    await act(async () => {
      backend.seed("setup-claude");
    });
    await waitFor(() => expect(replace.mock.calls).toEqual([["/setup/claude"]]), {
      timeout: 5_000,
    });
    // Gone while still offline, inside this test's own time: the paused fetch then has nothing
    // to resume into when afterEach comes back online, and the shared cleanup has no screen to
    // wait on.
    await act(async () => {
      screen.unmount();
    });
  }, 20_000);
});
