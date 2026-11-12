import { describe, expect, test } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import { CanvasStack } from "../components/canvas-stack";
import { canvasStatus } from "../lib/canvas/status";

/** The stack as the canvas screen draws it for a head row. */
function Stack(head: Parameters<typeof canvasStatus>[0], prNumber: number | null = null) {
  const status = canvasStatus(head, { status: "ready", doc: null });
  return <CanvasStack bottom={42} right={16} prNumber={prNumber} chat={status.chat} />;
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

  test("needs you: the count on Chat's edge outranks working", async () => {
    await render(Stack(head({ agentState: "needs_you", needsYouCount: 2 })));
    // Seen, not read twice: VoiceOver hears the count in Chat's own label.
    const hidden = { includeHiddenElements: true };
    expect(screen.getByTestId("stack-chat-badge", hidden)).toBeTruthy();
    expect(screen.getByText("2", hidden)).toBeTruthy();
    expect(screen.queryByText("2")).toBeNull();
    expect(screen.getByLabelText("Chat, Ponzu has 2 questions")).toBeTruthy();
    expect(screen.queryByTestId("stack-chat-working")).toBeNull();
  });

  test("one question is said as one", async () => {
    await render(Stack(head({ agentState: "needs_you", needsYouCount: 1 })));
    expect(screen.getByLabelText("Chat, Ponzu has a question")).toBeTruthy();
  });

  test("the pull request's button shows once there is one", async () => {
    await render(Stack(head(), 412));
    expect(screen.getByLabelText("Pull request #412")).toBeTruthy();
  });

  test("until their sheets arrive, the buttons are there and said to be unavailable", async () => {
    await render(Stack(head(), 412));
    for (const id of ["stack-pr", "stack-comment", "stack-chat"]) {
      expect(screen.getByTestId(id).props.accessibilityState).toMatchObject({ disabled: true });
    }
  });
});
