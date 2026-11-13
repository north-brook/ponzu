import { expect, test } from "bun:test";
import type { CanvasSummary, SearchResults } from "./model.ts";
import { moveSelection, resultAt, resultGroup, resultKeys } from "./search.ts";

// How a result's text splits at its matches (`segments`) is tested in @ponzu/core, where it is.

const on = (id: string) => ({ id, name: id });
const hit = { matches: [], snippet: "", at: null };

/** One result in every group, two canvases sharing a board id and a page id. */
const everyGroup: SearchResults = {
  query: "x",
  canvases: [
    { canvas: { id: "cnv_1" } as CanvasSummary, matches: [] },
    { canvas: { id: "cnv_2" } as CanvasSummary, matches: [] },
  ],
  boards: [
    {
      id: "pg_1",
      place: "page",
      pageId: "pg_1",
      name: "",
      icon: null,
      matches: [],
      canvas: on("cnv_1"),
    },
    {
      id: "ab_1",
      place: "board",
      pageId: "pg_1",
      name: "",
      icon: null,
      matches: [],
      canvas: on("cnv_1"),
    },
    // The same board id on another canvas (a duplicate made by copying) is another result.
    {
      id: "ab_1",
      place: "board",
      pageId: null,
      name: "",
      icon: null,
      matches: [],
      canvas: on("cnv_2"),
    },
  ],
  comments: [
    {
      ...hit,
      id: "msg_1",
      threadId: "th_1",
      pageId: null,
      artboardId: null,
      resolved: false,
      author: "agent",
      canvas: on("cnv_1"),
    },
  ],
  messages: [{ ...hit, id: "itm_1", seq: 4, author: "deleted", canvas: on("cnv_2") }],
  pullRequests: [{ number: 412, title: "", matches: [], state: null, canvas: on("cnv_1") }],
  people: [
    {
      id: "usr_1",
      login: "maya",
      name: null,
      avatarUrl: null,
      nameMatches: [],
      loginMatches: [],
    },
  ],
};

test("the keyboard goes through every group in the list's order, stopping at the ends", () => {
  expect(resultKeys(everyGroup)).toEqual([
    "canvas:cnv_1",
    "canvas:cnv_2",
    "page:cnv_1/pg_1",
    "board:cnv_1/ab_1",
    "board:cnv_2/ab_1",
    "comment:cnv_1/th_1/msg_1",
    "message:cnv_2/itm_1",
    "pr:cnv_1/412",
    "person:usr_1",
  ]);
  expect(moveSelection(4, 0, "ArrowDown")).toBe(1);
  expect(moveSelection(4, 3, "ArrowDown")).toBe(3);
  expect(moveSelection(4, 0, "ArrowUp")).toBe(0);
  expect(moveSelection(4, -1, "ArrowDown")).toBe(0);
  expect(moveSelection(4, 2, "Home")).toBeNull();
  expect(moveSelection(0, 0, "ArrowDown")).toBeNull();
});

test("pages and boards keep the order the server ranked them in, in one group", () => {
  const boardFirst: SearchResults = {
    ...everyGroup,
    boards: [everyGroup.boards[1]!, everyGroup.boards[0]!],
  };
  expect(resultKeys(boardFirst).slice(2, 4)).toEqual(["board:cnv_1/ab_1", "page:cnv_1/pg_1"]);
});

test("a key finds its result, its group and its place in the list; a gone one finds nothing", () => {
  const board = resultAt(everyGroup, "board:cnv_2/ab_1")!;
  expect(board.position).toBe(4);
  expect(board.result.kind).toBe("board");
  expect(board.result.hit).toBe(everyGroup.boards[2]!);
  expect(resultGroup(board.result)).toBe("boards");
  const groups = resultKeys(everyGroup).map((key) =>
    resultGroup(resultAt(everyGroup, key)!.result),
  );
  expect(groups).toEqual([
    "canvases",
    "canvases",
    "boards",
    "boards",
    "boards",
    "comments",
    "messages",
    "pullRequests",
    "people",
  ]);
  expect(resultAt(everyGroup, "board:cnv_3/ab_1")).toBeNull();
});

test("a result the answer somehow holds twice is listed once", () => {
  const twice: SearchResults = {
    ...everyGroup,
    comments: [...everyGroup.comments, ...everyGroup.comments],
  };
  expect(resultKeys(twice)).toEqual(resultKeys(everyGroup));
});
