import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { Artboard } from "@ponzu/core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import * as ReactNative from "react-native";
import Settings from "../app/settings";
import { CanvasList } from "../components/canvas-list";
import { backend, NORTH, stockCanvases } from "../lib/cloud/backend.fake";
import { useCanvasList } from "../lib/cloud/canvases";
import { CloudProvider } from "../lib/cloud/query";
import { forgetWorkspaces } from "../lib/cloud/workspace";

const push = router.push as unknown as jest.Mock;

/** The Canvases tab's list, as the tab draws it, without its native header. */
function List() {
  const canvases = useCanvasList();
  return <CanvasList {...canvases} margin={16} />;
}

/** One of acme's canvases by name. */
function canvasNamed(name: string) {
  const { fake, acme } = backend.world;
  const found = [...fake.canvases.values()].find(
    (c) => c.workspaceId === acme.id && c.sequencer.doc.name === name,
  );
  if (!found) throw new Error(`No canvas called ${name}`);
  return found;
}

/** A board, so the agent has something to commit: the canvas moves on past what Maya saw. */
function board(id: string): Artboard {
  return {
    id,
    name: id,
    x: 0,
    y: 0,
    root: { kind: "el", id, tag: "section", attrs: {}, style: {}, children: [] },
  } as Artboard;
}

/** The rows' names, top to bottom, as the list shows them. */
const rowNames = () =>
  screen
    .getAllByTestId(/^canvas-[a-z]+_[0-9a-z]+$/)
    .map((row) => row.props.accessibilityLabel.split(", ")[0]);

beforeEach(async () => {
  push.mockClear();
  backend.reset();
  forgetWorkspaces();
  await AsyncStorage.clear();
  await backend.prepare();
});

/** The appearance a test asked for, put back after it. */
let appearance: { mockRestore(): void } | null = null;

afterEach(() => {
  appearance?.mockRestore();
  appearance = null;
});

describe("the canvases list", () => {
  test("on a team, the canvas waiting on Maya comes first; settled ones wait in the tray", async () => {
    await stockCanvases(backend.world);
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    await screen.findByText("Pricing page");
    expect(rowNames()).toEqual(["Pricing page", "Onboarding"]);
    expect(screen.queryByText("Launch poster")).toBeNull();
    expect(screen.getByRole("button", { name: "Settled, 1" })).toBeTruthy();
  });

  test("on a personal workspace, newest activity first, a question or not", async () => {
    const { fake, sam } = backend.world;
    const ws = [...fake.workspaces.values()].find((w) => w.githubLogin === "sam")!;
    const { api } = fake.connect(sam);
    const older = await api.canvases.create({ workspaceId: ws.id, repoId: null, name: "Older" });
    const newer = await api.canvases.create({ workspaceId: ws.id, repoId: null, name: "Newer" });
    fake.agent(older.id).ask(
      {
        kind: "question",
        payload: {
          questions: [{ header: "Size", question: "How big?", options: [], multiSelect: false }],
        },
      },
      "Size",
    );
    fake.canvas(older.id).lastActivityAt = "2026-11-01T00:00:00.000Z";
    fake.canvas(newer.id).lastActivityAt = "2026-11-09T00:00:00.000Z";
    backend.seed("empty");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    await screen.findByText("Older");
    expect(rowNames()).toEqual(["Newer", "Older"]);
  });

  test("one indicator each: needs you, then working, then unseen", async () => {
    await stockCanvases(backend.world);
    const poster = canvasNamed("Launch poster");
    await backend.world.fake.connect(backend.world.maya).api.canvases.settle(poster.id, false);
    const page = poster.sequencer.doc.pages[0]!.id;
    backend.world.fake
      .agent(poster.id)
      .commit([{ op: "artboard.create", page, index: 0, artboard: board("ab_poster") }]);
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    const pricing = canvasNamed("Pricing page").id;
    const onboarding = canvasNamed("Onboarding").id;
    const needsYou = await screen.findByTestId(`canvas-${pricing}-needs-you`);
    expect(within(needsYou).getByText("1")).toBeTruthy();
    // Pricing waits on Maya and has moved on since: needs you alone shows.
    expect(screen.queryByTestId(`canvas-${pricing}-unseen`)).toBeNull();
    expect(screen.getByTestId(`canvas-${onboarding}-working`)).toBeTruthy();
    expect(screen.getByTestId(`canvas-${poster.id}-unseen`)).toBeTruthy();
    expect(screen.queryByTestId(`canvas-${poster.id}-working`)).toBeNull();
  });

  test("a row waiting on Maya says its question in place of its branch", async () => {
    await stockCanvases(backend.world);
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    const pricing = canvasNamed("Pricing page").id;
    const line = await screen.findByTestId(`canvas-${pricing}-question`);
    expect(line).toHaveTextContent("Button colour  Which blue for the buttons?");
    expect(
      screen.getByLabelText(/^Pricing page, 1 waiting for you, site, .*Button colour: Which blue/),
    ).toBeTruthy();
  });

  test.each(["light", "dark"] as const)(
    "a preview in the phone's appearance (%s), from the canvas's files",
    async (scheme) => {
      appearance = jest.spyOn(ReactNative, "useColorScheme").mockReturnValue(scheme);
      await stockCanvases(backend.world);
      const pricing = canvasNamed("Pricing page");
      backend.seed("signed-in");
      await render(
        <CloudProvider>
          <List />
        </CloudProvider>,
      );
      const preview = await screen.findByTestId(`canvas-${pricing.id}-preview`);
      expect(preview.props.source).toEqual([
        expect.objectContaining({
          uri: `https://assets.test/${pricing.id}/previews/${pricing.previewSeq}-${scheme}.png`,
        }),
      ]);
      // A canvas with no preview yet shows its ground, and nothing is asked for it.
      expect(screen.queryByTestId(`canvas-${canvasNamed("Onboarding").id}-preview`)).toBeNull();
    },
  );

  test("a press opens the canvas", async () => {
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    await fireEvent.press(await screen.findByLabelText(/^Onboarding, /));
    expect(push).toHaveBeenCalledWith(`/canvas/${canvasNamed("Onboarding").id}`);
  });

  test("holding a row settles it into the tray, and the tray's Reopen brings it back", async () => {
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    await screen.findByText("Onboarding");
    const row = () => screen.getByTestId("menu Onboarding");
    await fireEvent.press(within(row()).getByRole("menuitem", { name: "Settle" }));
    const tray = await screen.findByRole("button", { name: "Settled, 1" });
    expect(screen.queryByText("Onboarding")).toBeNull();
    await fireEvent.press(tray);
    expect(await screen.findByText("Onboarding")).toBeTruthy();
    await fireEvent.press(within(row()).getByRole("menuitem", { name: "Reopen" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Settled/ })).toBeNull());
    expect(rowNames()).toContain("Onboarding");
  });

  test("a settle that doesn't take leaves the row and says so, as the Mac does", async () => {
    backend.seed("signed-in");
    const settle = jest
      .spyOn(backend.api.canvases, "settle")
      .mockRejectedValueOnce(new Error("offline"));
    const alert = jest.spyOn(ReactNative.Alert, "alert").mockImplementation(() => {});
    try {
      await render(
        <CloudProvider>
          <List />
        </CloudProvider>,
      );
      await screen.findByText("Onboarding");
      await fireEvent.press(
        within(screen.getByTestId("menu Onboarding")).getByRole("menuitem", { name: "Settle" }),
      );
      await waitFor(() =>
        expect(alert).toHaveBeenCalledWith("“Onboarding” couldn't be changed. Try again."),
      );
      expect(screen.getByText("Onboarding")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Settled/ })).toBeNull();
    } finally {
      settle.mockRestore();
      alert.mockRestore();
    }
  });

  test("while nothing has come, the rows' shapes stand in", async () => {
    await render(<CanvasList list={undefined} loading margin={16} />);
    expect(screen.getByTestId("canvases-loading")).toBeTruthy();
    expect(screen.queryByTestId("canvases-empty")).toBeNull();
  });

  test("a workspace with nothing in it leaves a faint trace and one line", async () => {
    backend.seed("empty");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    expect(
      await screen.findByLabelText("No canvases yet. Canvases you make in Ponzu show up here."),
    ).toBeTruthy();
    expect(screen.queryByTestId("canvases-loading")).toBeNull();
  });
});

describe("settings", () => {
  test("picking another workspace shows its canvases, and keeps it for next time", async () => {
    await stockCanvases(backend.world);
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <Settings />
        <List />
      </CloudProvider>,
    );
    await screen.findByText("Pricing page");
    const acme = await screen.findByRole("button", { name: "Acme" });
    expect(acme.props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    await fireEvent.press(screen.getByRole("button", { name: NORTH.name }));
    expect(await screen.findByText(NORTH.canvas)).toBeTruthy();
    expect(screen.queryByText("Pricing page")).toBeNull();
    const north = [...backend.world.fake.workspaces.values()].find(
      (w) => w.githubLogin === NORTH.login,
    )!;
    expect(await AsyncStorage.getItem(`ponzu.workspace.${backend.world.maya.id}`)).toBe(north.id);
  });

  test("one workspace: no list of them", async () => {
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <Settings />
      </CloudProvider>,
    );
    await screen.findByTestId("settings-usage");
    expect(screen.queryByTestId("settings-workspaces")).toBeNull();
  });

  test("usage is read only: the total and its line, and nothing to pay, add or raise", async () => {
    const { fake, acme, maya } = backend.world;
    fake.settings.use(acme.id, maya.id, 40);
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <Settings />
      </CloudProvider>,
    );
    expect(await screen.findByTestId("usage-headline")).toHaveTextContent("$4.00");
    expect(screen.getByTestId("usage-line")).toHaveTextContent(
      /^used this month in Acme · 1 person · 40 credits, all free · resets /,
    );
    const usage = screen.getByTestId("settings-usage");
    expect(within(usage).queryAllByRole("button")).toEqual([]);
    expect(within(usage).queryByText(/card|pay|upgrade|raise|cap/i)).toBeNull();
  });
});
