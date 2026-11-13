import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { ApiError } from "@ponzu/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { onlineManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { SearchResults } from "../components/search-results";
import { backend, CHAT_SCENE, SEARCH_SCENE, stockSearch } from "../lib/cloud/backend.fake";
import { CloudProvider } from "../lib/cloud/query";
import { forgetWorkspaces } from "../lib/cloud/workspace";
import { SEARCH } from "../lib/copy";

/*
 * The Search tab's list on the fake (search design §10): the recent canvases before typing;
 * Canvases, Boards and Threads from the API's search as words are typed; a thread result opening
 * the chat at its message; and an API with no search route, one that fails, and no network.
 */

const push = router.push as unknown as jest.Mock;

function Search({ query }: { query: string }) {
  return (
    <CloudProvider>
      <SearchResults query={query} margin={16} />
    </CloudProvider>
  );
}

/** The Pricing page's id in the fake. */
function pricingId(): string {
  const { fake, acme } = backend.world;
  const found = [...fake.canvases.values()].find(
    (c) => c.workspaceId === acme.id && c.sequencer.doc.name === "Pricing page",
  );
  if (!found) throw new Error("No Pricing page");
  return found.id;
}

beforeEach(async () => {
  push.mockClear();
  backend.reset();
  forgetWorkspaces();
  await AsyncStorage.clear();
  await backend.prepare();
  await stockSearch(backend.world);
  backend.seed("signed-in");
});

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  onlineManager.setOnline(true);
});

describe("search", () => {
  test("before typing: the canvases changed most recently, with what each is doing", async () => {
    await render(<Search query="" />);
    // The Pricing page's turn is running: Claude is working, now, on its branch.
    const pricing = await screen.findByTestId(`search-recent-${pricingId()}`);
    expect(pricing.props.accessibilityLabel).toMatch(/^Pricing page, Claude is working · now · /);
    expect(screen.getByText("Onboarding")).toBeTruthy();
    expect(screen.getByText("Launch poster")).toBeTruthy();
    // No section labels before typing.
    expect(screen.queryByText(SEARCH.canvases)).toBeNull();
  });

  test("typing: Boards and Threads from the API, and a thread opens the chat at its message", async () => {
    const asked = jest.spyOn(backend.api.workspaces, "search");
    restore.push(() => asked.mockRestore());
    await render(<Search query={SEARCH_SCENE.query} />);
    await screen.findByTestId("search-section-boards");
    expect(screen.getByText(SEARCH.boards)).toBeTruthy();
    expect(screen.getByText(SEARCH.threads)).toBeTruthy();
    // No canvas is called "plans": no Canvases section.
    expect(screen.queryByTestId("search-section-canvases")).toBeNull();
    const id = pricingId();
    expect(screen.getByTestId(`search-board-${id}-ab_plans`).props.accessibilityLabel).toBe(
      "Plans, in Pricing page",
    );
    // Maya's comment on Plans and her ask in the thread, both under Threads.
    expect(screen.getByTestId(`search-comment-${id}-m_search`)).toBeTruthy();
    const ask = screen.getAllByLabelText(new RegExp(`^Maya · Pricing page, .*${CHAT_SCENE.ask}`));
    expect(ask).toHaveLength(1);
    // The words went in the request's body, with the phone's four groups.
    expect(asked).toHaveBeenCalled();
    const [workspaceId, body] = asked.mock.calls.at(-1) as [
      string,
      { q: string; groups: string[] },
    ];
    expect(workspaceId).toBe(backend.world.acme.id);
    expect(body).toEqual({ q: "plans", groups: ["canvases", "boards", "comments", "messages"] });
    // A message opens its canvas with the chat sheet up at it.
    const seq = backend.world.fake
      .canvas(id)
      .thread.map((entry) => entry.item)
      .find((item) => item.kind === "message" && item.payload.text === CHAT_SCENE.ask)!.seq;
    await fireEvent.press(ask[0]!);
    expect(push).toHaveBeenCalledWith(`/canvas/${id}?sheet=chat&message=${seq}`);
    // A board opens on its page, in focus.
    await fireEvent.press(screen.getByTestId(`search-board-${id}-ab_plans`));
    expect(push).toHaveBeenLastCalledWith(
      expect.stringMatching(new RegExp(`^/canvas/${id}\\?page=pg_[^&]+&artboard=ab_plans$`)),
    );
    // A comment opens at its pin, its thread open.
    await fireEvent.press(screen.getByTestId(`search-comment-${id}-m_search`));
    expect(push).toHaveBeenLastCalledWith(
      expect.stringMatching(
        new RegExp(`^/canvas/${id}\\?page=pg_[^&]+&artboard=ab_plans&thread=th_search$`),
      ),
    );
  });

  test("a canvas by name, with its place; nothing found says so", async () => {
    const view = await render(<Search query={SEARCH_SCENE.canvasQuery} />);
    const row = await screen.findByTestId(`search-canvas-${pricingId()}`);
    expect(row.props.accessibilityLabel).toMatch(/^Pricing page, site · /);
    await view.rerender(<Search query="zebra" />);
    await screen.findByText(SEARCH.noResults("zebra"));
  });

  test("an API with no search route (404): names alone, no Boards or Threads", async () => {
    const absent = jest
      .spyOn(backend.api.workspaces, "search")
      .mockRejectedValue(new ApiError(404, "not_found", "Not found."));
    restore.push(() => absent.mockRestore());
    const view = await render(<Search query={SEARCH_SCENE.canvasQuery} />);
    await waitFor(() => expect(absent).toHaveBeenCalled());
    await screen.findByTestId(`search-canvas-${pricingId()}`);
    // Words only the API could find: nothing, and no error, since there is no route to fail.
    await view.rerender(<Search query={SEARCH_SCENE.query} />);
    await screen.findByText(SEARCH.noResults(SEARCH_SCENE.query));
    expect(screen.queryByTestId("search-section-boards")).toBeNull();
    expect(screen.queryByTestId("search-section-threads")).toBeNull();
    expect(screen.queryByText(SEARCH.failed)).toBeNull();
  });

  test("search failing: the names held still show; with none, that it isn't answering", async () => {
    const failing = jest
      .spyOn(backend.api.workspaces, "search")
      .mockRejectedValue(new ApiError(500, "internal", "Boom."));
    restore.push(() => failing.mockRestore());
    const view = await render(<Search query={SEARCH_SCENE.query} />);
    // One retry after a 5xx, then the line.
    await screen.findByText(SEARCH.failed, {}, { timeout: 8000 });
    await view.rerender(<Search query={SEARCH_SCENE.canvasQuery} />);
    await screen.findByTestId(`search-canvas-${pricingId()}`, {}, { timeout: 8000 });
  });

  test("with no network, it never sits searching: names, or that it isn't answering", async () => {
    // The list comes first, then the network goes.
    const view = await render(<Search query="" />);
    await screen.findByTestId(`search-recent-${pricingId()}`);
    await act(async () => onlineManager.setOnline(false));
    await view.rerender(<Search query={SEARCH_SCENE.query} />);
    await screen.findByText(SEARCH.failed);
    await view.rerender(<Search query={SEARCH_SCENE.canvasQuery} />);
    await screen.findByTestId(`search-canvas-${pricingId()}`);
    expect(screen.queryByText(SEARCH.searching)).toBeNull();
  });
});
