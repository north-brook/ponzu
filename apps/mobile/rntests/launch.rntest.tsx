import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { SessionState } from "@ponzu/client";
import { act, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import Launch from "../app/index";
import { backend } from "../lib/cloud/backend.fake";

const replace = router.replace as unknown as jest.Mock;
/** The fake session's own setter, for a state no scenario names (still reading the Keychain). */
const setState = (state: SessionState) =>
  (backend.session as unknown as { set(state: SessionState): void }).set(state);

/** The launch screen, on a clock the test moves. */
async function launch(ms: number) {
  await render(<Launch />);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  replace.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("launch goes where the session says", () => {
  const cases: [string, string][] = [
    ["signed-out", "/sign-in"],
    ["github-reauth", "/sign-in"],
    ["too-old", "/update"],
    ["signed-in", "/canvases"],
  ];
  for (const [scenario, route] of cases) {
    test(`${scenario} → ${route}`, async () => {
      backend.seed(scenario);
      await launch(2_000);
      expect(replace.mock.calls).toEqual([[route]]);
    });
  }

  test("never before the bloom has landed", async () => {
    backend.seed("signed-out");
    await launch(300);
    expect(replace).not.toHaveBeenCalled();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });
    expect(replace.mock.calls).toEqual([["/sign-in"]]);
  });

  test("while the session is still being read it stays, and says so after 8 seconds", async () => {
    setState({ status: "loading" });
    await launch(7_000);
    expect(screen.queryByText("Can't reach Ponzu. Trying again.")).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.getByText("Can't reach Ponzu. Trying again.")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    // Then the session answers, and the launch goes on.
    await act(async () => {
      backend.seed("signed-in");
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(replace.mock.calls).toEqual([["/canvases"]]);
  });
});
