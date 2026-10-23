import { expect, test } from "bun:test";
import { intentFor, intentLine, type JournalEntry, opLine, parseJournal } from "./journal.ts";

const agent = { kind: "agent" as const, name: "Claude", client: "claude" };
const MIN = 60_000;

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

test("a film opens on the request its stretch of work answers", () => {
  const op = (t: number) =>
    parseJournal(opLine({ op: "note", name: "n", content: "x" }, agent, [], t))[0]!;
  const said = (t: number, text: string) => parseJournal(intentLine(text, agent, t))[0]!;
  const entries: JournalEntry[] = [
    said(0, "Yesterday's request"),
    op(1 * MIN),
    // A day later: the agent says what it's taking on just before it starts.
    said(1440 * MIN, "Today's request"),
    op(1441 * MIN),
    said(1450 * MIN, "A follow-up in the same session"),
    op(1451 * MIN),
  ];
  expect(intentFor(entries, 1441 * MIN, 1451 * MIN)).toBe("Today's request");
  // Said a moment after the first edit still counts.
  expect(intentFor(entries.slice(3), 1441 * MIN, 1451 * MIN)).toBe(
    "A follow-up in the same session",
  );
  // An earlier session's request is about other work.
  expect(intentFor(entries.slice(0, 2), 1441 * MIN, 1451 * MIN)).toBeNull();
});
