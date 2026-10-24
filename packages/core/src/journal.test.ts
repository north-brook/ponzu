import { expect, test } from "bun:test";
import { intentLine, parseJournal } from "./journal.ts";

const agent = { kind: "agent" as const, name: "Claude", client: "claude" };

test("an intent round-trips through the journal, with the agent's mark", () => {
  const [e] = parseJournal(intentLine("A fitness app: today, workout and progress.", agent, 5));
  expect(e).toEqual({
    v: 1,
    t: 5,
    kind: "intent",
    text: "A fitness app: today, workout and progress.",
    origin: agent,
  });
});
