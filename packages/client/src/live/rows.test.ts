import { expect, test } from "bun:test";
// The registry the API seals from. Read here, in a test, to hold the client's copy to it.
import { LIVE_QUERIES } from "../../../../apps/api/src/live/queries.ts";
import { DECODE, LIVE_COLUMNS, type RawRow } from "./rows.ts";
import { byRecentActivity, bySeq, presentNow } from "./sort.ts";

/** The names a query's SELECT list gives its columns: an alias, or the column itself. */
function selected(sql: string): string[] {
  const list = sql.slice(sql.indexOf("select") + "select".length, sql.search(/\sfrom\s/));
  return list.split(",").map((item) => {
    const words = item.trim().split(/\s+/);
    return words.length === 3 && words[1] === "as" ? words[2]! : words[0]!.split(".").at(-1)!;
  });
}

test("the client knows exactly the queries the API seals, column for column", () => {
  expect(Object.keys(LIVE_COLUMNS).sort()).toEqual(Object.keys(LIVE_QUERIES).sort());
  for (const [name, query] of Object.entries(LIVE_QUERIES)) {
    expect({ name, columns: selected(query.sql) }).toEqual({
      name,
      columns: [...LIVE_COLUMNS[name as keyof typeof LIVE_COLUMNS]],
    });
  }
});

test("a row as Realtime sends it becomes one the apps read", () => {
  const raw: RawRow<"design.head"> = {
    id: "dsn_1",
    workspace_id: "ws_1",
    name: "Kettle",
    icon: null,
    status: "active",
    seq: "10",
    preview_seq: null,
    agent_state: "working",
    agent_status: "Drawing",
    agent_artboards: ["ab_1"],
    needs_you_count: 0,
    pr_number: 7,
    pr_state: "open",
    pr_checks: "passing",
    pr_mergeable: true,
    pr_auto_merge: false,
    last_activity_at: new Date("2026-11-10T12:00:00Z"),
    sandbox_state: "awake",
  };
  const head = DECODE["design.head"](raw);
  expect(head.seq).toBe(10);
  expect(head.lastActivityAt).toBe("2026-11-10T12:00:00.000Z");
  expect(head.agentArtboards).toEqual(["ab_1"]);

  const thread = DECODE["design.thread"]({
    id: "ti_1",
    design_id: "dsn_1",
    seq: "3",
    kind: "assistant",
    user_id: null,
    payload: { text: "Hello" },
    streaming: true,
    created_at: new Date("2026-11-10T12:00:00.5Z"),
    updated_at: new Date("2026-11-10T12:00:01Z"),
  });
  expect(thread).toEqual({
    id: "ti_1",
    seq: 3,
    at: "2026-11-10T12:00:00.500Z",
    streaming: true,
    kind: "assistant",
    payload: { text: "Hello" },
  });
});

test("lists are put in order on the client", () => {
  const design = (id: string, lastActivityAt: string) =>
    ({ id, lastActivityAt }) as Parameters<typeof byRecentActivity>[0][number];
  expect(
    byRecentActivity([
      design("a", "2026-11-01T00:00:00.000Z"),
      design("c", "2026-11-03T00:00:00.000Z"),
      design("b", "2026-11-03T00:00:00.000Z"),
    ]).map((d) => d.id),
  ).toEqual(["b", "c", "a"]);

  const item = (seq: number) => ({ seq }) as Parameters<typeof bySeq>[0][number];
  expect(bySeq([item(10), item(9), item(100)]).map((i) => i.seq)).toEqual([9, 10, 100]);

  const now = Date.parse("2026-11-10T12:02:00.000Z");
  const present = (userId: string, joinedAt: string, seenAt: string) =>
    ({ userId, joinedAt, seenAt }) as Parameters<typeof presentNow>[0][number];
  expect(
    presentNow(
      [
        present("late", "2026-11-10T12:01:00.000Z", "2026-11-10T12:01:50.000Z"),
        present("gone", "2026-11-10T11:00:00.000Z", "2026-11-10T12:00:44.000Z"),
        present("first", "2026-11-10T12:00:00.000Z", "2026-11-10T12:00:45.000Z"),
      ],
      now,
    ).map((p) => p.userId),
  ).toEqual(["first", "late"]);
});
