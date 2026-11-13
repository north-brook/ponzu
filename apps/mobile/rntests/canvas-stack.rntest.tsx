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

  test("needs you: Chat wears the count, and says it to VoiceOver", async () => {
    await render(Stack(head({ agentState: "needs_you", needsYouCount: 2 })));
    const hidden = { includeHiddenElements: true };
    expect(screen.getByTestId("stack-chat-badge", hidden)).toBeTruthy();
    expect(screen.getByText("2", hidden)).toBeTruthy();
    // The badge itself is hidden from VoiceOver: Chat's label carries the count.
    expect(screen.queryByTestId("stack-chat-badge")).toBeNull();
    expect(screen.getByLabelText("Chat, Ponzu has 2 questions")).toBeTruthy();
    expect(screen.queryByTestId("stack-chat-working")).toBeNull();
  });

  test("needs you outranks working, and one question is said as one", async () => {
    await render(Stack(head({ agentState: "working", needsYouCount: 1 })));
    expect(screen.getByLabelText("Chat, Ponzu has a question")).toBeTruthy();
    expect(screen.getByText("1", { includeHiddenElements: true })).toBeTruthy();
  });

  test("past 99, the count says 99+", async () => {
    await render(Stack(head({ agentState: "needs_you", needsYouCount: 140 })));
    expect(screen.getByText("99+", { includeHiddenElements: true })).toBeTruthy();
  });

  test("the pull request's button shows once there is one", async () => {
    await render(Stack(head(), 412));
    expect(screen.getByLabelText("Pull request #412")).toBeTruthy();
  });

  test("Chat opens the chat, and the pull request its sheet, with no alert in between", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const onChat = jest.fn();
    const onPullRequest = jest.fn();
    const status = canvasStatus(head(), { status: "ready", doc: null });
    await render(
      <CanvasStack
        bottom={42}
        right={16}
        prNumber={412}
        chat={status.chat}
        onChat={onChat}
        onPullRequest={onPullRequest}
      />,
    );
    for (const id of ["stack-pr", "stack-chat"]) {
      expect(screen.getByTestId(id).props.accessibilityState).not.toMatchObject({ disabled: true });
    }
    await fireEvent.press(screen.getByTestId("stack-chat"));
    expect(onChat).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId("stack-pr"));
    expect(onPullRequest).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  test("Comment without a handler (a canvas they may only look at) is said to be unavailable", async () => {
    await render(Stack(head()));
    expect(screen.getByTestId("stack-comment").props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});
