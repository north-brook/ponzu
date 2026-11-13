import { describe, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Alert } from "react-native";
import { CanvasStack } from "../components/canvas-stack";
import { canvasStatus } from "../lib/canvas/status";

/** The stack as the canvas screen draws it for a head row. */
function Stack(
  head: Parameters<typeof canvasStatus>[0],
  prNumber: number | null = null,
  onChat: () => void = () => {},
) {
  const status = canvasStatus(head, { status: "ready", doc: null });
  return (
    <CanvasStack bottom={42} right={16} prNumber={prNumber} chat={status.chat} onChat={onChat} />
  );
}

const head = (over: Partial<NonNullable<Parameters<typeof canvasStatus>[0]>> = {}) => ({
  agentState: "idle" as const,
  agentStatus: null,
  agentArtboards: [],
  agentBlocker: null,
  needsYouCount: 0,
  ...over,
});

describe("the canvas's floating stack", () => {
  test("asleep: Comment and Chat, no pull request, nothing turning", async () => {
    await render(Stack(head()));
    expect(screen.queryByTestId("stack-pr")).toBeNull();
    expect(screen.getByLabelText("Comment")).toBeTruthy();
    expect(screen.getByLabelText("Chat")).toBeTruthy();
    expect(screen.queryByTestId("stack-chat-working")).toBeNull();
    expect(screen.queryByTestId("stack-chat-badge")).toBeNull();
  });

  test.each(["waking", "working"] as const)(
    "%s: Chat's mark is the turning slice",
    async (agentState) => {
      await render(Stack(head({ agentState })));
      expect(screen.getByTestId("stack-chat-working")).toBeTruthy();
      expect(screen.getByLabelText("Chat, Ponzu is working")).toBeTruthy();
    },
  );

  test("needs you: no count is shown, since the phone can't answer a question yet", async () => {
    await render(Stack(head({ agentState: "needs_you", needsYouCount: 2 })));
    const hidden = { includeHiddenElements: true };
    expect(screen.queryByTestId("stack-chat-badge", hidden)).toBeNull();
    expect(screen.queryByText("2", hidden)).toBeNull();
    expect(screen.getByLabelText("Chat")).toBeTruthy();
    expect(screen.queryByTestId("stack-chat-working")).toBeNull();
  });

  test("the pull request's button shows once there is one", async () => {
    await render(Stack(head(), 412));
    expect(screen.getByLabelText("Pull request #412")).toBeTruthy();
  });

  test("Chat opens the chat; the pull request says it comes in the next update", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const onChat = jest.fn();
    await render(Stack(head(), 412, onChat));
    for (const id of ["stack-pr", "stack-chat"]) {
      expect(screen.getByTestId(id).props.accessibilityState).not.toMatchObject({ disabled: true });
    }
    await fireEvent.press(screen.getByTestId("stack-chat"));
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("stack-pr"));
    expect(alert).toHaveBeenLastCalledWith(
      "Pull requests aren't on the iPhone yet. They come in the next update.",
    );
    expect(alert).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });

  test("Comment without a handler (a canvas they may only look at) is said to be unavailable", async () => {
    await render(Stack(head()));
    expect(screen.getByTestId("stack-comment").props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});
