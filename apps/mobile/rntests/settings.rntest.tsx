import { beforeEach, describe, expect, type jest, test } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { Text } from "react-native";
import Settings from "../app/settings";
import { CanvasNameRow } from "../components/canvas-name-row";
import { backend } from "../lib/cloud/backend.fake";
import { useCanvases } from "../lib/cloud/canvases";
import { CloudProvider } from "../lib/cloud/query";

const replace = router.replace as unknown as jest.Mock;

/** The canvases list's rows, as the Canvases tab draws them, without its native header. */
function List() {
  const { canvases, loading } = useCanvases();
  if (loading) return <Text>loading</Text>;
  return (
    <>
      {canvases?.map((canvas) => (
        <CanvasNameRow key={canvas.id} canvas={canvas} margin={16} />
      ))}
      {canvases?.length === 0 && <Text>No canvases yet.</Text>}
    </>
  );
}

beforeEach(async () => {
  replace.mockClear();
  await AsyncStorage.clear();
  await backend.prepare();
});

describe("the canvases list", () => {
  test("Maya sees acme's canvases by name, with where each lives", async () => {
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    expect(await screen.findByText("Pricing page")).toBeTruthy();
    expect(screen.getByText("Onboarding")).toBeTruthy();
    expect(screen.getByText("Launch poster")).toBeTruthy();
    expect(screen.getByText("acme/site")).toBeTruthy();
    expect(screen.getByText("Scratch")).toBeTruthy();
    expect(screen.getByLabelText("Launch poster, Scratch")).toBeTruthy();
  });

  test("a workspace with nothing in it says so", async () => {
    backend.seed("empty");
    await render(
      <CloudProvider>
        <List />
      </CloudProvider>,
    );
    expect(await screen.findByText("No canvases yet.")).toBeTruthy();
  });
});

describe("settings", () => {
  test("shows who is signed in", async () => {
    backend.seed("signed-in");
    await render(
      <CloudProvider>
        <Settings />
      </CloudProvider>,
    );
    expect(screen.getByText("Maya Lin")).toBeTruthy();
    expect(screen.getByText("@maya")).toBeTruthy();
  });

  test("Sign out ends the session, forgets this person's keys but the ping ask's, and goes to sign-in", async () => {
    backend.seed("signed-in");
    await AsyncStorage.multiSet([
      ["ponzu.workspace.usr_1", "ws_1"],
      ["ponzu.drafts.cnv_1", "a comment"],
      ["ponzu.pingAsk", "later"],
    ]);
    await render(
      <CloudProvider>
        <Settings />
      </CloudProvider>,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
    expect(backend.session.getState()).toEqual({ status: "signed_out" });
    expect([...(await AsyncStorage.getAllKeys())]).toEqual(["ponzu.pingAsk"]);
  });
});
