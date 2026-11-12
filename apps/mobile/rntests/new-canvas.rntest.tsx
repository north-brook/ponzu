import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { ApiError } from "@ponzu/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Alert, Text } from "react-native";
import NewCanvas from "../app/new";
import PickProject from "../app/pick-project";
import { backend, NORTH, stockCanvases } from "../lib/cloud/backend.fake";
import { useCanvasList } from "../lib/cloud/canvases";
import { MODEL_CHOICE_KEY } from "../lib/cloud/create";
import { currentDraft, forgetNewCanvas } from "../lib/cloud/new-canvas";
import { CloudProvider } from "../lib/cloud/query";
import { forgetFirstCanvas, useFirstCanvas } from "../lib/cloud/use-first-canvas";
import { forgetWorkspaces } from "../lib/cloud/workspace";

// A picked photo's bytes, as the file on disk would give them.
jest.mock("expo-file-system", () => ({
  ...jest.requireActual<object>("expo-file-system"),
  File: class {
    async arrayBuffer() {
      return new Uint8Array([0xff, 0xd8, 0xff]).buffer;
    }
  },
}));

const replace = router.replace as unknown as jest.Mock;
const push = router.push as unknown as jest.Mock;
const alert = jest.spyOn(Alert, "alert");

type Buttons = { text?: string; onPress?: () => void }[];

/** The canvases the fake holds in a workspace, by name. */
function canvasesIn(workspaceId: string) {
  return [...backend.world.fake.canvases.values()].filter((c) => c.workspaceId === workspaceId);
}

async function show(node: ReactNode = <NewCanvas />) {
  await render(<CloudProvider>{node}</CloudProvider>);
  // The project is known once acme's repos have come.
  await screen.findByLabelText("Project: acme/site");
}

async function type(text: string) {
  await fireEvent.changeText(screen.getByTestId("new-canvas-prompt"), text);
}

const send = () => fireEvent.press(screen.getByTestId("new-canvas-send"));

beforeEach(async () => {
  replace.mockClear();
  push.mockClear();
  alert.mockReset();
  backend.reset();
  forgetWorkspaces();
  forgetNewCanvas();
  forgetFirstCanvas();
  await AsyncStorage.clear();
  await backend.prepare();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("new canvas", () => {
  test("in the Mac's words, in the repo pushed to last, and Send waits for a prompt", async () => {
    backend.seed("signed-in");
    await show();
    expect(screen.getByRole("header", { name: "Make something in acme/site" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Describe what you want to make")).toBeTruthy();
    const button = screen.getByTestId("new-canvas-send");
    expect(button).toBeDisabled();
    await type("   ");
    expect(button).toBeDisabled();
    await type("Design a pricing card for the site");
    expect(button).toBeEnabled();
  });

  test("with the keyboard up, the project control stays above the composer, not under it", async () => {
    backend.seed("signed-in");
    await show();
    // The prompt is focused as the screen opens, so the keyboard is up from the start. The
    // statement and the composer make way for it together: the composer above the keyboard
    // and the project control above the composer, where a person can see it and tap it.
    const avoiding = screen.getByTestId("new-canvas-keyboard");
    expect(avoiding.props.behavior).toBe("padding");
    expect(within(avoiding).getByTestId("new-canvas-project")).toBeTruthy();
    expect(within(avoiding).getByTestId("new-canvas-composer")).toBeTruthy();
  });

  test("Send makes the canvas with its first message and opens it in this screen's place", async () => {
    backend.seed("signed-in");
    const { acme } = backend.world;
    const before = canvasesIn(acme.id).length;
    await show();
    await type("Design a pricing card for the site");
    await send();
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    const made = canvasesIn(acme.id);
    expect(made).toHaveLength(before + 1);
    const canvas = made.at(-1)!;
    expect(canvas.sequencer.doc.name).toBe("Pricing card for the site");
    expect(canvas.repoId).toBe(acme.repos[0]!.id);
    expect(canvas.thread.map(({ item }) => item.kind)).toContain("message");
    expect(replace).toHaveBeenCalledWith(`/canvas/${canvas.id}`);
    // The draft goes with the send.
    expect(screen.getByTestId("new-canvas-prompt").props.value).toBe("");
  });

  test("with photos, the canvas is made, they go up, then the message says them", async () => {
    (global as { picked?: unknown }).picked = [
      { uri: "file:///a.jpg", fileName: "a.jpg", mimeType: "image/jpeg", assetId: "a" },
      { uri: "file:///b.jpg", fileName: "b.jpg", mimeType: "image/jpeg", assetId: "b" },
    ];
    try {
      backend.seed("signed-in");
      await show();
      await fireEvent.press(screen.getByRole("button", { name: "Attach" }));
      await fireEvent.press(await screen.findByRole("button", { name: "Remove b.jpg" }));
      expect(screen.queryByRole("button", { name: "Remove b.jpg" })).toBeNull();
      await type("A hero like this photo");
      await send();
      await waitFor(() => expect(replace).toHaveBeenCalled());
      const canvas = canvasesIn(backend.world.acme.id).at(-1)!;
      expect([...canvas.assets.keys()]).toEqual([expect.stringMatching(/^assets\/a-.+\.jpg$/)]);
      const said = canvas.thread.map(({ item }) => item).find((item) => item.kind === "message");
      expect(said?.payload).toMatchObject({
        text: "A hero like this photo",
        attachments: [{ ref: expect.stringMatching(/^assets\/a-/), contentType: "image/jpeg" }],
      });
    } finally {
      (global as { picked?: unknown }).picked = undefined;
    }
  });

  test("a double tap makes one canvas", async () => {
    backend.seed("signed-in");
    const { acme } = backend.world;
    const before = canvasesIn(acme.id).length;
    await show();
    await type("A launch poster");
    // The API takes a moment to answer, so the second tap lands while the first is on its way.
    backend.world.fake.latencyMs = 30;
    const button = screen.getByTestId("new-canvas-send");
    await fireEvent.press(button);
    await fireEvent.press(button);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(canvasesIn(acme.id)).toHaveLength(before + 1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  test("while a send is on its way, the project can't change", async () => {
    backend.seed("signed-in");
    await show();
    await type("A launch poster");
    const canvases = backend.api.canvases;
    const create = canvases.create;
    let answer: () => void = () => {};
    const held = jest
      .spyOn(canvases, "create")
      .mockImplementationOnce(async (body: Parameters<typeof create>[0]) => {
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return create(body);
      });
    try {
      await send();
      await waitFor(() => expect(held).toHaveBeenCalled());
      const project = screen.getByTestId("new-canvas-project");
      expect(project).toBeDisabled();
      await fireEvent.press(project);
      expect(push).not.toHaveBeenCalled();
      await act(async () => answer());
      await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    } finally {
      held.mockRestore();
    }
  });

  test("a send that finishes after the screen has gone moves nothing", async () => {
    backend.seed("signed-in");
    const { acme } = backend.world;
    const before = canvasesIn(acme.id).length;
    await show();
    await type("A launch poster");
    const canvases = backend.api.canvases;
    const create = canvases.create;
    let answer: () => void = () => {};
    const held = jest
      .spyOn(canvases, "create")
      .mockImplementationOnce(async (body: Parameters<typeof create>[0]) => {
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return create(body);
      });
    try {
      await send();
      await waitFor(() => expect(held).toHaveBeenCalled());
      await act(async () => screen.unmount());
      await act(async () => answer());
      // The canvas is made and its prompt spent (the send's last step before it would move
      // the screen), but nothing replaces whatever screen is there now.
      await waitFor(() => expect(canvasesIn(acme.id)).toHaveLength(before + 1));
      await waitFor(() => expect(currentDraft()).toBe(""));
      expect(replace).not.toHaveBeenCalled();
    } finally {
      held.mockRestore();
    }
  });

  test("the model and effort picked go with the canvas, and are kept for the next", async () => {
    backend.seed("signed-in");
    await show();
    const model = await screen.findByTestId("new-canvas-model");
    expect(model).toHaveAccessibleName("Model: Opus 5.5, effort Medium");
    await fireEvent.press(screen.getByRole("menuitem", { name: "Sonnet 5.5" }));
    await fireEvent.press(screen.getByRole("menuitem", { name: "High" }));
    expect(screen.getByTestId("new-canvas-model")).toHaveAccessibleName(
      "Model: Sonnet 5.5, effort High",
    );
    await type("A settings page");
    await send();
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const canvas = canvasesIn(backend.world.acme.id).at(-1)!;
    expect([canvas.model, canvas.effort]).toEqual(["claude-sonnet-5-5", "high"]);
    expect(JSON.parse((await AsyncStorage.getItem(MODEL_CHOICE_KEY)) ?? "null")).toEqual({
      model: "claude-sonnet-5-5",
      effort: "high",
    });
  });

  test("a send that fails says why in the Mac's words and keeps the prompt", async () => {
    backend.seed("signed-in");
    await show();
    await screen.findByTestId("new-canvas-model");
    // The account stops offering Opus after the picker read what it offers.
    backend.world.fake.claude.offer(backend.world.maya.id, [
      { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: ["low"] },
    ]);
    await type("A pricing page");
    await send();
    expect(await screen.findByTestId("new-canvas-error")).toHaveTextContent(
      "Your Claude account doesn't offer that model any more. Check the model and send it again.",
    );
    expect(screen.getByTestId("new-canvas-prompt").props.value).toBe("A pricing page");
    expect(replace).not.toHaveBeenCalled();
  });

  test("a photo that didn't go up keeps the canvas; sent again, it is the same one", async () => {
    // A file the API won't take as an image: the canvas is made, its upload is refused.
    (global as { picked?: unknown }).picked = [
      { uri: "file:///notes.txt", fileName: "notes.txt", mimeType: "text/plain", assetId: "n" },
    ];
    try {
      backend.seed("signed-in");
      const { acme } = backend.world;
      const before = canvasesIn(acme.id).length;
      await show();
      await fireEvent.press(screen.getByRole("button", { name: "Attach" }));
      await type("A hero like this photo");
      await send();
      expect(await screen.findByTestId("new-canvas-error")).toHaveTextContent(
        "The canvas is made, but your message didn't go with it. Send it again.",
      );
      expect(canvasesIn(acme.id)).toHaveLength(before + 1);
      expect(screen.getByTestId("new-canvas-prompt").props.value).toBe("A hero like this photo");
      // Without it, sent again: the same canvas, now with its message.
      await fireEvent.press(screen.getByRole("button", { name: "Remove notes.txt" }));
      await send();
      await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
      expect(canvasesIn(acme.id)).toHaveLength(before + 1);
      const canvas = canvasesIn(acme.id).at(-1)!;
      expect(replace).toHaveBeenCalledWith(`/canvas/${canvas.id}`);
      const said = canvas.thread.map(({ item }) => item).find((item) => item.kind === "message");
      expect(said?.payload).toMatchObject({ text: "A hero like this photo" });
    } finally {
      (global as { picked?: unknown }).picked = undefined;
    }
  });

  test("a canvas made whose answer was lost still gets its message when sent again", async () => {
    (global as { picked?: unknown }).picked = [
      { uri: "file:///a.jpg", fileName: "a.jpg", mimeType: "image/jpeg", assetId: "a" },
    ];
    const canvases = backend.api.canvases;
    const create = canvases.create;
    // The API makes the canvas, but its answer never reaches the phone.
    const lost = jest
      .spyOn(canvases, "create")
      .mockImplementationOnce(async (body: Parameters<typeof create>[0]) => {
        await create(body);
        throw new ApiError(0, "network", "No answer.");
      });
    try {
      backend.seed("signed-in");
      const { acme } = backend.world;
      const before = canvasesIn(acme.id).length;
      await show();
      await fireEvent.press(screen.getByRole("button", { name: "Attach" }));
      await type("A hero like this photo");
      await send();
      expect(await screen.findByTestId("new-canvas-error")).toHaveTextContent(
        "Ponzu can't be reached. Check your connection and send it again.",
      );
      expect(canvasesIn(acme.id)).toHaveLength(before + 1);
      // Sent again without the photo: the same key answers the canvas made, which then hears
      // the message, rather than the message being lost to the key.
      await fireEvent.press(screen.getByRole("button", { name: "Remove a.jpg" }));
      await send();
      await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
      expect(canvasesIn(acme.id)).toHaveLength(before + 1);
      const canvas = canvasesIn(acme.id).at(-1)!;
      const said = canvas.thread.map(({ item }) => item).filter((item) => item.kind === "message");
      expect(said).toHaveLength(1);
      expect(said[0]?.payload).toMatchObject({ text: "A hero like this photo" });
    } finally {
      lost.mockRestore();
      (global as { picked?: unknown }).picked = undefined;
    }
  });

  test("a plan at its limit asks first, and Cancel keeps the prompt", async () => {
    const until = new Date(Date.now() + 3 * 3600_000).toISOString();
    backend.limitClaude(until);
    backend.seed("signed-in");
    const { acme } = backend.world;
    const before = canvasesIn(acme.id).length;
    await show();
    await type("A pricing page");
    await send();
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, line, buttons] = alert.mock.calls[0]! as [string, string, Buttons];
    expect(title).toBe("Your Claude plan is at its limit");
    expect(line).toMatch(/^Your Claude plan resets at .+\. Ponzu sends this then\.$/);
    expect(buttons.map((b) => b.text)).toEqual(["Cancel", "Send then"]);
    // Cancel: nothing is made, and the prompt is still there.
    expect(canvasesIn(acme.id)).toHaveLength(before);
    expect(screen.getByTestId("new-canvas-prompt").props.value).toBe("A pricing page");
    // Send then: the canvas is made, and waits for the plan.
    await act(async () => buttons[1]!.onPress!());
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(canvasesIn(acme.id)).toHaveLength(before + 1);
  });

  test("a Claude that ran out opens the Claude card; connected, the kept prompt goes", async () => {
    const { fake, maya, acme } = backend.world;
    // A subscription whose year is long over.
    fake.claude.connect(maya.id, "subscription", 1);
    backend.seed("signed-in");
    const before = canvasesIn(acme.id).length;
    await show();
    await type("A pricing page");
    await send();
    expect(await screen.findByText("Your Claude sign-in ran out")).toBeTruthy();
    expect(
      screen.getByText("Sign in to Claude again and Ponzu sends this. Your prompt is saved."),
    ).toBeTruthy();
    expect(canvasesIn(acme.id)).toHaveLength(before);
    await fireEvent.press(screen.getByTestId("connect-claude-add-key"));
    await fireEvent.changeText(screen.getByTestId("setup-claude-key-field"), "sk-ant-test-key");
    await fireEvent.press(screen.getByTestId("connect-claude-connect"));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const canvas = canvasesIn(acme.id).at(-1)!;
    expect(canvas.sequencer.doc.name).toBe("Pricing page");
    expect(canvasesIn(acme.id)).toHaveLength(before + 1);
  });

  test("closing the Claude card sends nothing and keeps the prompt", async () => {
    const { fake, maya, acme } = backend.world;
    fake.claude.connect(maya.id, "subscription", 1);
    backend.seed("signed-in");
    const before = canvasesIn(acme.id).length;
    await show();
    await type("A pricing page");
    await send();
    await fireEvent.press(await screen.findByTestId("connect-claude-cancel"));
    expect(screen.queryByTestId("connect-claude-sheet")).toBeNull();
    // Claude connected elsewhere afterwards does not send it by itself.
    fake.claude.connect(maya.id);
    await act(async () => {});
    expect(canvasesIn(acme.id)).toHaveLength(before);
    expect(screen.getByTestId("new-canvas-prompt").props.value).toBe("A pricing page");
  });
});

describe("pick a project", () => {
  test("each workspace's Scratch first, then its repos; the chosen one is ticked", async () => {
    await stockCanvases(backend.world);
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <PickProject />
      </CloudProvider>,
    );
    const site = await screen.findByRole("button", { name: "acme/site" });
    expect(site).toBeSelected();
    expect(
      screen.getByRole("button", { name: "Scratch in Acme, no repo, kept in Ponzu" }),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "north/brand" })).not.toBeSelected();
    expect(screen.getByRole("header", { name: NORTH.name })).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("pick-project-search"), "brand");
    expect(screen.queryByRole("button", { name: "acme/site" })).toBeNull();
    expect(screen.getByRole("button", { name: "north/brand" })).toBeTruthy();
  });

  test("picking Scratch in this workspace makes it the project", async () => {
    backend.seed("signed-in");
    await show(
      <>
        <PickProject />
        <NewCanvas />
      </>,
    );
    await fireEvent.press(screen.getByRole("button", { name: /^Scratch, no repo/ }));
    expect(screen.getByRole("header", { name: "Make something from scratch" })).toBeTruthy();
    expect(screen.getByLabelText("Project: Scratch in Acme")).toBeTruthy();
  });

  test("a repo in another workspace switches the workspace, and the canvas is made there", async () => {
    await stockCanvases(backend.world);
    backend.seed("signed-in");
    const { fake, maya } = backend.world;
    const north = [...fake.workspaces.values()].find((w) => w.githubLogin === NORTH.login)!;
    await show(
      <>
        <PickProject />
        <NewCanvas />
      </>,
    );
    await fireEvent.press(await screen.findByRole("button", { name: "north/brand" }));
    expect(await screen.findByLabelText("Project: north/brand")).toBeTruthy();
    expect(await AsyncStorage.getItem(`ponzu.workspace.${maya.id}`)).toBe(north.id);
    const before = canvasesIn(north.id).length;
    await type("A brand refresh poster");
    await send();
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(canvasesIn(north.id)).toHaveLength(before + 1);
  });
});

describe("the first canvas", () => {
  /** The list's hook, saying once its rows have come. */
  function List() {
    const canvases = useCanvasList();
    useFirstCanvas(canvases);
    return canvases.list ? <Text>Rows here</Text> : null;
  }

  test("an empty workspace gets New canvas by itself, once", async () => {
    backend.seed("empty");
    const { unmount } = await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/new"));
    await unmount();
    forgetFirstCanvas();
    push.mockClear();
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    // The key on the phone says it came already.
    await screen.findByText("Rows here");
    await act(async () => {});
    expect(push).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(`ponzu.firstCanvas.${backend.world.sam.id}`)).toBe("1");
  });

  test("a workspace with canvases doesn't", async () => {
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    await screen.findByText("Rows here");
    await act(async () => {});
    expect(push).not.toHaveBeenCalled();
  });
});
