// How `searchCanvases` matches and ranks, exactly: tiers, recency, the tie-break, the caps, a
// pull request's number, short terms, phrases, and what a person's punctuation cannot do.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc, type SearchEntry, searchTerms } from "@ponzu/core";
import { eq, sql } from "drizzle-orm";
import { seedUser, seedWorkspace } from "../fixtures.ts";
import { canvases, searchEntries, users } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership } from "./accounts.ts";
import { createCanvas } from "./canvases.ts";
import { type SearchGroup, searchCanvases, upsertSearchEntries } from "./search.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

/** A workspace with one member, and a way to make their Scratch canvases and entries. */
async function space() {
  const [user, workspace] = await Promise.all([seedUser(db, "ada"), seedWorkspace(db)]);
  await upsertMembership(db, { workspaceId: workspace.id, userId: user.id, role: "member" });
  let day = 1;
  /** A canvas named `name`, last active on a later day than the one made before it. */
  const canvas = async (name: string, activeOn = day++) => {
    const made = await createCanvas(db, {
      workspaceId: workspace.id,
      repoId: null,
      ownerId: user.id,
      claudeAccountId: null,
      name,
      branch: null,
      doc: emptyDoc(name),
    });
    await db
      .update(canvases)
      .set({ lastActivityAt: new Date(Date.UTC(2026, 9, activeOn)) })
      .where(eq(canvases.id, made.id));
    return made.id;
  };
  const entries = (canvasId: string, list: SearchEntry[]) =>
    upsertSearchEntries(db, { canvasId, entries: list });
  const find = async (query: string, groups?: SearchGroup[]) =>
    searchCanvases(db, {
      workspaceId: workspace.id,
      userId: user.id,
      terms: searchTerms(query),
      ...(groups ? { groups } : {}),
    });
  const names = async (query: string) => (await find(query)).canvases.map((hit) => hit.text);
  return { user, workspace, canvas, entries, find, names };
}

const comment = (ref: string, text: string, at: number | null, authorId: string | null = null) =>
  ({
    kind: "comment",
    ref,
    text,
    context: {
      kind: "comment",
      threadId: ref.split("/")[0]!,
      messageId: ref.split("/")[1] ?? "m",
      pageId: null,
      artboardId: null,
      resolved: false,
    },
    author: authorId ? { kind: "user", id: authorId, name: "Stored name" } : null,
    at,
  }) satisfies SearchEntry;

const pullRequest = (number: number, title: string) =>
  ({
    kind: "pull_request",
    ref: String(number),
    text: `#${number} ${title}`,
    context: { kind: "pull_request", number },
    author: null,
    at: null,
  }) satisfies SearchEntry;

describe("ranking", () => {
  test("exact, then prefix, then every term at a word start, then anywhere, whatever is newer", async () => {
    const s = await space();
    // Made oldest first, so recency alone would put them in the reverse order.
    await s.canvas("Zebra");
    await s.canvas("Zebra crossing");
    await s.canvas("Big zebra");
    await s.canvas("Mazebras");
    const hits = (await s.find("zebra")).canvases;
    expect(hits.map((hit) => [hit.text, hit.tier])).toEqual([
      ["Zebra", 0],
      ["Zebra crossing", 1],
      ["Big zebra", 2],
      ["Mazebras", 3],
    ]);
  });

  test("the whole query is compared with runs of spaces and punctuation made one space", async () => {
    const s = await space();
    await s.canvas("  Zebra -- crossing! ");
    await s.canvas("Zebra crossing guide");
    const hits = (await s.find("zebra crossing")).canvases;
    expect(hits.map((hit) => [hit.text, hit.tier])).toEqual([
      ["  Zebra -- crossing! ", 0],
      ["Zebra crossing guide", 1],
    ]);
  });

  test("within a tier, the newest first: an entry's own time, else its canvas's last activity", async () => {
    const s = await space();
    const older = await s.canvas("Older zebra");
    const newer = await s.canvas("Newer zebra");
    expect(await s.names("zebra")).toEqual(["Newer zebra", "Older zebra"]);

    // The comment on the older canvas was said after the newer canvas's last activity.
    await s.entries(older, [comment("th_1/m_1", "a zebra here", Date.UTC(2026, 10, 1))]);
    await s.entries(newer, [comment("th_2/m_1", "a zebra there", null)]);
    const hits = (await s.find("zebra")).comments;
    expect(hits.map((hit) => hit.text)).toEqual(["a zebra here", "a zebra there"]);
    expect(hits[1]!.rankedAt).toEqual(new Date(Date.UTC(2026, 9, 2)));
  });

  test("the same tier and time are broken by canvas id, then key", async () => {
    const s = await space();
    const ids = [await s.canvas("Zebra one", 5), await s.canvas("Zebra two", 5)];
    const hits = (await s.find("zebra")).canvases;
    expect(hits.map((hit) => hit.canvasId)).toEqual([...ids].sort());
    await s.entries(ids[0]!, [
      comment("th_b/m", "zebra", 1_000),
      comment("th_a/m", "zebra", 1_000),
    ]);
    expect((await s.find("zebra")).comments.map((hit) => hit.ref)).toEqual(["th_a/m", "th_b/m"]);
  });

  test("at most 8 of each group and 4 pull requests, the best of them", async () => {
    const s = await space();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await s.canvas(`Zebra ${i}`));
    const exact = await s.canvas("Old", 0);
    await db.update(canvases).set({ name: "zebra" }).where(eq(canvases.id, exact));
    await s.entries(exact, [
      {
        kind: "canvas",
        ref: "",
        text: "zebra",
        context: { kind: "canvas" },
        author: null,
        at: null,
      },
      ...[1, 2, 3, 4, 5, 6].map((n) => pullRequest(n, "Zebra")),
      ...Array.from({ length: 10 }, (_, n) => comment(`th_${n}/m`, "zebra", n)),
    ]);
    const hits = await s.find("zebra");
    expect(hits.canvases).toHaveLength(8);
    // The exact name first, though its canvas is the least recently active.
    expect(hits.canvases[0]!.canvasId).toBe(exact);
    expect(hits.canvases.slice(1).map((hit) => hit.text)).toEqual(
      [9, 8, 7, 6, 5, 4, 3].map((n) => `Zebra ${n}`),
    );
    expect(hits.comments).toHaveLength(8);
    expect(hits.pullRequests).toHaveLength(4);
  });

  test("'#412' finds pull request 412 first, as exact, and #1412 after it", async () => {
    const s = await space();
    const canvas = await s.canvas("Checkout");
    await s.entries(canvas, [pullRequest(1412, "Ship it"), pullRequest(412, "Fix login")]);
    await db
      .update(canvases)
      .set({ prNumber: 412, prState: "draft" })
      .where(eq(canvases.id, canvas));
    const hits = (await s.find("#412")).pullRequests;
    expect(hits.map((hit) => [hit.text, hit.tier])).toEqual([
      ["#412 Fix login", 0],
      ["#1412 Ship it", 3],
    ]);
    expect(hits[0]!.canvasPr).toEqual({ number: 412, state: "draft" });
    expect(hits[0]!.context).toEqual({ kind: "pull_request", number: 412 });
  });
});

describe("matching", () => {
  test("every term must match, in any order", async () => {
    const s = await space();
    await s.canvas("Zebra crossing");
    await s.canvas("Zebra");
    expect(await s.names("crossing zebra")).toEqual(["Zebra crossing"]);
    expect(await s.names("zebra lion")).toEqual([]);
  });

  test("a short term matches only at a word start, and searches names alone", async () => {
    const s = await space();
    const canvas = await s.canvas("Zebra");
    await s.canvas("Mazebra");
    await s.entries(canvas, [
      {
        kind: "board",
        ref: "ab_1",
        text: "Zest board",
        context: { kind: "board", pageId: "p" },
        author: null,
        at: null,
      },
      comment("th_1/m", "zebra zest", 1),
      {
        kind: "message",
        ref: "ti_1",
        text: "zebra zest",
        context: { kind: "message", itemSeq: 1 },
        author: { kind: "agent", id: null, name: "Ponzu" },
        at: 1,
      },
      pullRequest(7, "Zebra stripes"),
    ]);
    const hits = await s.find("ze");
    expect(hits.canvases.map((hit) => hit.text)).toEqual(["Zebra"]);
    expect(hits.boards.map((hit) => hit.text)).toEqual(["Zest board"]);
    expect(hits.pullRequests.map((hit) => hit.text)).toEqual(["#7 Zebra stripes"]);
    expect(hits.comments).toEqual([]);
    expect(hits.messages).toEqual([]);
    // One long word lets the long text in, with the short term still at a word start.
    const both = await s.find("ze zebra");
    expect(both.comments.map((hit) => hit.text)).toEqual(["zebra zest"]);
    expect(both.messages.map((hit) => hit.text)).toEqual(["zebra zest"]);
    expect((await s.find("ze zebra")).canvases.map((hit) => hit.text)).toEqual(["Zebra"]);
    // "#7" is a short term too: it finds pull request 7 by its number.
    expect((await s.find("#7")).pullRequests.map((hit) => hit.tier)).toEqual([0]);
  });

  test("a phrase matches its words in order, one or more spaces or punctuation apart", async () => {
    const s = await space();
    await s.canvas("Zebra -- crossing");
    await s.canvas("Crossing zebra");
    await s.canvas("Zebra and crossing");
    expect(await s.names('"zebra crossing"')).toEqual(["Zebra -- crossing"]);
    expect(await s.names("“crossing zebra”")).toEqual(["Crossing zebra"]);
  });

  test("accents, case and punctuation are folded the same on both sides", async () => {
    const s = await space();
    await s.canvas("Crème BRÛLÉE");
    expect(await s.names("creme brulee")).toEqual(["Crème BRÛLÉE"]);
    expect(await s.names("BRÛL")).toEqual(["Crème BRÛLÉE"]);
  });

  test("punctuation is never a wildcard: '1%0' does not find '1x0', nor 'a_b' 'axb', nor 'a\\b' 'axb'", async () => {
    const s = await space();
    await s.canvas("1x0");
    await s.canvas("axb");
    await s.canvas("a_b");
    await s.canvas("1000");
    await s.canvas("100 percent");
    expect(await s.names("1%0")).toEqual([]);
    expect(await s.names("a_b")).toEqual(["a_b"]);
    expect(await s.names("a\\b")).toEqual(["a_b"]);
    expect(await s.names("%")).toEqual([]);
    expect(await s.names("_")).toEqual([]);
    // '100%' is the term 100: it finds exactly what '100' finds, '1000' among them, since a
    // term matches anywhere in a word. The '%' adds nothing.
    expect(await s.names("100%")).toEqual(await s.names("100"));
    expect(await s.names("100%")).toEqual(["100 percent", "1000"]);
  });

  test("a regex metacharacter in a phrase is folded away, never sent", async () => {
    const s = await space();
    await s.canvas("zebra crossing");
    expect(await s.names('"zebra.* crossing"')).toEqual(["zebra crossing"]);
    expect(await s.names('"zebra (crossing"')).toEqual(["zebra crossing"]);
    expect(await s.names('"z.bra crossing"')).toEqual([]);
  });

  test("the empty entries commits leave are never hits", async () => {
    const s = await space();
    const canvas = await s.canvas("Plain");
    await db.insert(searchEntries).values({
      canvasId: canvas,
      kind: "page",
      ref: "pg_gone",
      text: "",
      folded: "",
      context: { kind: "page" },
    });
    for (const query of ["a", "ab", "zebra", '"a b"']) {
      expect((await s.find(query)).boards).toEqual([]);
    }
  });

  test("only the groups asked for, and no terms or groups asks nothing", async () => {
    const s = await space();
    const canvas = await s.canvas("Zebra");
    await s.entries(canvas, [comment("th_1/m", "zebra", 1)]);
    const hits = await s.find("zebra", ["comments"]);
    expect(hits.canvases).toEqual([]);
    expect(hits.comments).toHaveLength(1);
    expect(await s.find("!!!")).toEqual({
      canvases: [],
      boards: [],
      comments: [],
      messages: [],
      pullRequests: [],
    });
    expect((await s.find("zebra", [])).canvases).toEqual([]);
  });

  test("terms that could reach a pattern unchecked are refused", async () => {
    const s = await space();
    await expect(
      searchCanvases(db, {
        workspaceId: s.workspace.id,
        userId: s.user.id,
        terms: [{ words: ["50%"], short: false }],
      }),
    ).rejects.toThrow("letters, digits and marks");
  });
});

describe("authors", () => {
  test("a person's current row, a deleted person's none, and the agent", async () => {
    const s = await space();
    const canvas = await s.canvas("Zebra");
    const gone = await seedUser(db, "gone");
    await s.entries(canvas, [
      comment("th_1/m", "zebra by ada", 3, s.user.id),
      comment("th_2/m", "zebra by gone", 2, gone.id),
      {
        ...comment("th_3/m", "zebra by the agent", 1),
        author: { kind: "agent", id: null, name: "Ponzu" },
      },
    ]);
    await db.execute(sql`delete from ${users} where id = ${gone.id}`);
    const hits = (await s.find("zebra")).comments;
    expect(
      hits.map((hit) => [hit.text, hit.authorKind, hit.authorId, hit.authorName, hit.authorUser]),
    ).toEqual([
      [
        "zebra by ada",
        "user",
        s.user.id,
        "Stored name",
        { id: s.user.id, name: "ada", login: "ada", avatarUrl: null },
      ],
      ["zebra by gone", "user", gone.id, "Stored name", null],
      ["zebra by the agent", "agent", null, "Ponzu", null],
    ]);
    expect(hits[0]!.at).toEqual(new Date(3));
    expect(hits[0]!.canvasName).toBe("Zebra");
  });
});
