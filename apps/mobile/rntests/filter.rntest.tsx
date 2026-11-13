import { beforeEach, describe, expect, test } from "@jest/globals";
import { isFiltering, NO_FILTER } from "@ponzu/client/model";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { CanvasList } from "../components/canvas-list";
import { FilterSheet } from "../components/filter-sheet";
import { backend, FILTER_SCENE, stockFilter } from "../lib/cloud/backend.fake";
import { useCanvasList } from "../lib/cloud/canvases";
import { forgetFilters } from "../lib/cloud/filter";
import { filterKey } from "../lib/cloud/filter-rules";
import { CloudProvider } from "../lib/cloud/query";
import { forgetWorkspaces } from "../lib/cloud/workspace";

/** The Canvases tab's list as the tab draws it (canvases.tsx): through the filter. */
function List() {
  const { shown, loading, filter } = useCanvasList();
  return (
    <CanvasList
      list={shown}
      loading={loading}
      margin={16}
      filtering={isFiltering(filter.filter)}
      onClearFilter={() => filter.setFilter(NO_FILTER)}
    />
  );
}

/** The list with the filter sheet up over it, as the header's Filter opens it. */
async function open() {
  await render(
    <CloudProvider>
      <FilterSheet />
      <List />
    </CloudProvider>,
  );
  await screen.findByText(FILTER_SCENE.active);
}

/** The active rows' names, sorted: what the list shows above the tray. */
const rowNames = () =>
  screen
    .queryAllByTestId(/^canvas-[a-z]+_[0-9a-z]+$/)
    .map((row) => row.props.accessibilityLabel.split(", ")[0])
    .sort();

const EVERY = ["Checkout", "Launch poster", "Onboarding", "Pricing page"];

beforeEach(async () => {
  backend.reset();
  forgetWorkspaces();
  forgetFilters();
  await AsyncStorage.clear();
  await backend.prepare();
  await stockFilter(backend.world);
  backend.seed("signed-in");
});

describe("the filter", () => {
  test("the sheet offers you, your teammate, and each repo with Scratch last, with counts", async () => {
    await open();
    const people = screen.getAllByRole("radio").map((row) => row.props.accessibilityLabel);
    expect(people).toEqual(["Everyone", "You", FILTER_SCENE.teammate.name]);
    expect(screen.getByRole("radio", { name: "Everyone" }).props.accessibilityState).toEqual({
      checked: true,
    });
    await waitFor(() =>
      expect(screen.getAllByRole("checkbox").map((row) => row.props.accessibilityLabel)).toEqual([
        "app, 2",
        "site, 2",
        "Scratch, 1",
      ]),
    );
    expect(screen.queryByTestId("filter-clear")).toBeNull();
  });

  test("a person, then an unchecked repo, change the rows and the tray; Clear filter restores them", async () => {
    await open();
    await waitFor(() => expect(rowNames()).toEqual(EVERY));
    expect(screen.getByRole("button", { name: "Settled, 1" })).toBeTruthy();

    // Jun's alone: Checkout, and the settled Sign-up form in the tray.
    await fireEvent.press(screen.getByRole("radio", { name: FILTER_SCENE.teammate.name }));
    await waitFor(() => expect(rowNames()).toEqual(["Checkout"]));
    const tray = screen.getByRole("button", { name: "Settled, 1" });
    await fireEvent.press(tray);
    expect(screen.getByText(FILTER_SCENE.settled)).toBeTruthy();
    await fireEvent.press(tray);

    // Everyone, without site: Onboarding and the poster; the tray's Sign-up form is in app.
    await fireEvent.press(screen.getByRole("radio", { name: "Everyone" }));
    await fireEvent.press(screen.getByRole("checkbox", { name: "site, 2" }));
    await waitFor(() => expect(rowNames()).toEqual(["Launch poster", "Onboarding"]));
    expect(screen.getByRole("checkbox", { name: "site, 2" }).props.accessibilityState).toEqual({
      checked: false,
    });
    expect(screen.getByRole("button", { name: "Settled, 1" })).toBeTruthy();

    // Without app as well: the poster alone, and no tray.
    await fireEvent.press(screen.getByRole("checkbox", { name: "app, 2" }));
    await waitFor(() => expect(rowNames()).toEqual(["Launch poster"]));
    expect(screen.queryByRole("button", { name: /^Settled/ })).toBeNull();

    await fireEvent.press(screen.getByTestId("filter-clear"));
    await waitFor(() => expect(rowNames()).toEqual(EVERY));
    expect(screen.getByRole("button", { name: "Settled, 1" })).toBeTruthy();
    expect(screen.queryByTestId("filter-clear")).toBeNull();
  });

  test("a filter that keeps nothing says so, not the empty workspace's trace, and clears", async () => {
    await open();
    // Jun has nothing in Scratch that Maya can see.
    await fireEvent.press(screen.getByRole("radio", { name: FILTER_SCENE.teammate.name }));
    await fireEvent.press(screen.getByRole("checkbox", { name: "site, 2" }));
    await fireEvent.press(screen.getByRole("checkbox", { name: "app, 2" }));
    expect(await screen.findByText("No canvases match this filter.")).toBeTruthy();
    expect(rowNames()).toEqual([]);
    expect(screen.queryByTestId("canvases-empty")).toBeNull();
    await fireEvent.press(screen.getByTestId("canvases-clear-filter"));
    await waitFor(() => expect(rowNames()).toEqual(EVERY));
    expect(screen.queryByTestId("canvases-filtered")).toBeNull();
  });

  test("kept per person and workspace for the next launch", async () => {
    const { maya, acme } = backend.world;
    const view = await render(
      <CloudProvider>
        <FilterSheet />
        <List />
      </CloudProvider>,
    );
    await screen.findByText(FILTER_SCENE.active);
    await fireEvent.press(screen.getByRole("radio", { name: FILTER_SCENE.teammate.name }));
    await waitFor(() => expect(rowNames()).toEqual(["Checkout"]));
    await waitFor(async () =>
      expect(JSON.parse((await AsyncStorage.getItem(filterKey(maya.id))) ?? "{}")).toEqual({
        [acme.id]: { person: expect.stringMatching(/^usr_/), projects: null },
      }),
    );
    // The next launch: nothing in memory, the list opens filtered.
    await view.unmount();
    forgetFilters();
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    await screen.findByText(FILTER_SCENE.active);
    await waitFor(() => expect(rowNames()).toEqual(["Checkout"]));
  });

  test("a kept repo that has no canvases now doesn't hide everything", async () => {
    const { maya, acme } = backend.world;
    await AsyncStorage.setItem(
      filterKey(maya.id),
      JSON.stringify({ [acme.id]: { person: null, projects: ["repo:repo_gone"] } }),
    );
    await open();
    await waitFor(() => expect(rowNames()).toEqual(EVERY));
    expect(screen.queryByText("No canvases match this filter.")).toBeNull();
    expect(screen.queryByTestId("filter-clear")).toBeNull();
  });
});
