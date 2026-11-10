import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { actorFor, agent, rename, seedDesign } from "../fixtures.ts";
import { designOps } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { getDesign } from "./designs.ts";
import { claimEvents } from "./events.ts";
import { commit, commitOps, findOps, type OpEvent, readOps } from "./ops.ts";
import { QueryError } from "./run.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const logOf = (designId: string) =>
  db.select().from(designOps).where(eq(designOps.designId, designId)).orderBy(designOps.seq);

describe("commitOps", () => {
  test("appends a batch in order and moves the design's seq past it", async () => {
    const { design, user } = await seedDesign(db);
    const actor = { ...actorFor(user), avatarUrl: "https://example.com/bryce.png" };

    const result = await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor,
      ops: [rename("a", "One"), rename("b", "Two", "One"), rename("c", "Three", "Two")],
    });

    if (result.kind !== "committed") throw new Error("expected a commit");
    expect(result.seq).toBe(3);
    expect(result.replayed).toEqual([]);
    expect(result.ops.map((op) => [op.seq, op.id])).toEqual([
      [1, "a"],
      [2, "b"],
      [3, "c"],
    ]);
    expect(result.ops[1]).toMatchObject({
      op: { op: "file.rename", name: "Two" },
      inverse: { op: "file.rename", name: "One" },
      kind: "do",
      reverses: null,
      reversedBy: null,
      actor,
    });
    expect(result.ops[0]!.at).toBeInstanceOf(Date);
    expect(Math.abs(result.ops[0]!.at.getTime() - Date.now())).toBeLessThan(60_000);

    const after = await getDesign(db, design.id);
    expect(after!.seq).toBe(3);
    expect(after!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(design.lastActivityAt.getTime());
    expect((await logOf(design.id)).map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  test("a stale expectedSeq is a conflict and writes nothing", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    await commitOps(db, { designId: design.id, expectedSeq: 0, actor, ops: [rename("a", "One")] });

    const stale = await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor,
      ops: [rename("b", "Two")],
    });

    expect(stale).toEqual({ kind: "conflict" });
    expect((await getDesign(db, design.id))!.seq).toBe(1);
    expect((await logOf(design.id)).map((row) => row.clientOpId)).toEqual(["a"]);
  });

  test("a seq ahead of the design is a conflict too", async () => {
    const { design, user } = await seedDesign(db);
    const ahead = await commitOps(db, {
      designId: design.id,
      expectedSeq: 5,
      actor: actorFor(user),
      ops: [rename("a", "One")],
    });
    expect(ahead).toEqual({ kind: "conflict" });
    expect(await logOf(design.id)).toEqual([]);
  });

  test("a design that does not exist is a conflict", async () => {
    const missing = await commitOps(db, {
      designId: "des_missing",
      expectedSeq: 0,
      actor: agent,
      ops: [rename("a", "One")],
    });
    expect(missing).toEqual({ kind: "conflict" });
  });

  test("of committers racing on one seq exactly one wins, round after round", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    let seq = 0;

    for (let round = 0; round < 5; round++) {
      const racers = ["x", "y", "z", "w"].map((racer) =>
        commitOps(db, {
          designId: design.id,
          expectedSeq: seq,
          actor,
          ops: [rename(`${round}-${racer}-1`, "A"), rename(`${round}-${racer}-2`, "B")],
        }),
      );
      const results = await Promise.all(racers);

      const winners = results.filter((result) => result.kind === "committed");
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => result.kind === "conflict")).toHaveLength(3);
      seq += 2;
      expect(winners[0]).toMatchObject({ seq });
      expect((await getDesign(db, design.id))!.seq).toBe(seq);
    }

    // No gaps, no doubles, and only the winners' ops, two from each round.
    const log = await logOf(design.id);
    expect(log.map((row) => row.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    for (let round = 0; round < 5; round++) {
      const [first, second] = [log[round * 2]!, log[round * 2 + 1]!];
      expect(first.clientOpId.endsWith("-1")).toBe(true);
      expect(second.clientOpId).toBe(first.clientOpId.replace(/-1$/, "-2"));
    }
  });

  test("the loser of a race commits once it has caught up", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    const attempt = (id: string, expectedSeq: number) =>
      commitOps(db, { designId: design.id, expectedSeq, actor, ops: [rename(id, id)] });

    const [first, second] = await Promise.all([attempt("a", 0), attempt("b", 0)]);
    const loser = first.kind === "conflict" ? "a" : "b";
    expect([first.kind, second.kind].sort()).toEqual(["committed", "conflict"]);

    const caughtUp = await readOps(db, { designId: design.id, after: 0 });
    if (caughtUp?.kind !== "ok") throw new Error("expected ops");
    const retried = await attempt(loser, caughtUp.seq);

    expect(retried).toMatchObject({ kind: "committed", seq: 2 });
    expect((await logOf(design.id)).map((row) => row.seq)).toEqual([1, 2]);
  });

  test("posting an id again returns the original op and appends nothing", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    const first = await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor,
      ops: [rename("a", "One"), rename("b", "Two", "One")],
    });
    if (first.kind !== "committed") throw new Error("expected a commit");

    // The retry carries a seq that is now stale, and even different content: neither matters.
    const replay = await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: agent,
      ops: [rename("a", "Changed"), rename("b", "Changed too")],
    });

    expect(replay).toEqual({ kind: "committed", seq: 2, ops: first.ops, replayed: ["a", "b"] });
    expect((await getDesign(db, design.id))!.seq).toBe(2);
    expect(await logOf(design.id)).toHaveLength(2);
  });

  test("the same op posted twice at once is stored once", async () => {
    const { design, user } = await seedDesign(db);
    const post = () =>
      commitOps(db, {
        designId: design.id,
        expectedSeq: 0,
        actor: actorFor(user),
        ops: [rename("a", "One")],
      });

    const results = await Promise.all([post(), post(), post()]);

    // One of them appends it. Each of the others either started after and was handed the stored
    // op, or was waiting on the design's row and got a conflict; here they take turns, on a
    // real Postgres they wait (see ops.live.test.ts). Neither appends, and a retry replays.
    const committed = results.filter((result) => result.kind === "committed");
    expect(committed.filter((result) => result.replayed.length === 0)).toHaveLength(1);
    for (const result of committed) expect(result).toMatchObject({ seq: 1, ops: [{ seq: 1 }] });
    for (const result of results) expect(["committed", "conflict"]).toContain(result.kind);
    expect(await logOf(design.id)).toHaveLength(1);
    expect(await post()).toMatchObject({ kind: "committed", seq: 1, replayed: ["a"] });
  });

  test("a batch of replayed and new ops appends only the new ones", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor,
      ops: [rename("a", "One"), rename("b", "Two", "One")],
    });

    const mixed = await commitOps(db, {
      designId: design.id,
      expectedSeq: 2,
      actor,
      ops: [rename("c", "Three", "Two"), rename("a", "ignored"), rename("d", "Four", "Three")],
    });

    if (mixed.kind !== "committed") throw new Error("expected a commit");
    expect(mixed.seq).toBe(4);
    expect(mixed.replayed).toEqual(["a"]);
    expect(mixed.ops.map((op) => [op.id, op.seq])).toEqual([
      ["c", 3],
      ["a", 1],
      ["d", 4],
    ]);
    expect(mixed.ops[1]!.op).toEqual({ op: "file.rename", name: "One" });
    expect((await logOf(design.id)).map((row) => row.clientOpId)).toEqual(["a", "b", "c", "d"]);
  });

  test("a batch with anything new in it still needs the right seq", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    await commitOps(db, { designId: design.id, expectedSeq: 0, actor, ops: [rename("a", "One")] });

    const mixed = await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor,
      ops: [rename("a", "One"), rename("b", "Two")],
    });

    expect(mixed).toEqual({ kind: "conflict" });
    expect(await logOf(design.id)).toHaveLength(1);
  });

  test("a batch is stored whole or not at all", async () => {
    const { design, user } = await seedDesign(db);
    const target = { designId: design.id, expectedSeq: 0, actor: actorFor(user) };

    // The third entry breaks a check constraint (an undo that names nothing to take back),
    // after the design's row has been moved and two good ops have been inserted.
    const broken = commit(db, target, [
      { ...rename("a", "One"), kind: "do", reverses: null },
      { ...rename("b", "Two"), kind: "do", reverses: null },
      { ...rename("c", "Three"), kind: "undo", reverses: null },
    ]);

    const error = await broken.catch((thrown: Error) => thrown);
    expect((error as Error).message).toContain("design_ops_reverses_seq_check");
    expect((await getDesign(db, design.id))!.seq).toBe(0);
    expect(await logOf(design.id)).toEqual([]);
  });

  test("an op with text Postgres cannot store is named, and nothing is written", async () => {
    const { design, user } = await seedDesign(db);
    const target = { designId: design.id, expectedSeq: 0, actor: actorFor(user) };

    const result = await commitOps(db, {
      ...target,
      ops: [
        rename("fine", "Fine \ud83d\ude00"),
        rename("nul", "a\u0000b"),
        // What `text.slice(0, n)` leaves when it cuts an emoji in half.
        rename("half", "Launch \ud83d"),
        { id: "inverse", op: { op: "file.rename", name: "ok" }, inverse: rename("x", "\udc00").op },
        {
          id: "key",
          op: { op: "attrs", id: "n_1", attrs: { "data-\u0000": "x" } },
          inverse: rename("x", "y").op,
        },
      ],
    });

    expect(result).toEqual({ kind: "unstorable", ids: ["nul", "half", "inverse", "key"] });
    expect((await getDesign(db, design.id))!.seq).toBe(0);
    expect(await logOf(design.id)).toEqual([]);
    // With those rejected by the caller, the rest goes in, emoji and all.
    const retried = await commitOps(db, { ...target, ops: [rename("fine", "Fine \ud83d\ude00")] });
    expect(retried).toMatchObject({
      kind: "committed",
      ops: [{ op: { name: "Fine \ud83d\ude00" } }],
    });
  });

  test("a refused batch says what Postgres said and none of what was sent", async () => {
    const { design, user } = await seedDesign(db);
    const target = { designId: design.id, expectedSeq: 0, actor: actorFor(user) };

    const error = await commit(db, target, [
      { ...rename("a", "the-content-of-the-design"), kind: "undo", reverses: null },
    ]).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toContain("design_ops_reverses_seq_check");
    expect(`${(error as QueryError).message}\n${(error as QueryError).stack}`).not.toContain(
      "the-content-of-the-design",
    );
  });

  test("refuses an empty batch and a batch that repeats an id", async () => {
    const { design, user } = await seedDesign(db);
    const target = { designId: design.id, expectedSeq: 0, actor: actorFor(user) };

    await expect(commitOps(db, { ...target, ops: [] })).rejects.toThrow("at least one op");
    await expect(
      commitOps(db, { ...target, ops: [rename("a", "One"), rename("a", "Two")] }),
    ).rejects.toThrow("distinct ids");
    expect(await logOf(design.id)).toEqual([]);
  });

  test("keeps the keys of style and attrs in the order they were written", async () => {
    const { design, user } = await seedDesign(db);
    // jsonb would sort these by length, then alphabetically, and `margin-top` would lose to `margin`.
    const style = { "margin-top": "4px", margin: "0", color: "red", background: "blue", a: "1" };
    const attrs = { href: "#", class: "link", "aria-label": "Home", id: "x" };

    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [
        {
          id: "a",
          op: { op: "style", id: "n_1", style },
          inverse: { op: "attrs", id: "n_1", attrs },
        },
      ],
    });

    const read = await readOps(db, { designId: design.id, after: 0 });
    if (read?.kind !== "ok") throw new Error("expected ops");
    const [stored] = read.ops;
    if (stored?.op.op !== "style" || stored.inverse.op !== "attrs") throw new Error("wrong ops");
    expect(Object.keys(stored.op.style)).toEqual(Object.keys(style));
    expect(Object.keys(stored.inverse.attrs)).toEqual(Object.keys(attrs));
  });
});

describe("commitOps with events and the design's head", () => {
  const edit = (opId: string, userId: string, summary: string): OpEvent => ({
    opId,
    kind: "edit",
    priority: "later",
    payload: { summary },
    userId,
  });

  test("appends each op's events with the op, with the seq the op was given", async () => {
    const { design, user } = await seedDesign(db);

    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("a", "One"), rename("b", "Two", "One")],
      events: [edit("b", user.id, "second\u0000"), edit("a", user.id, "first")],
    });

    const claimed = await claimEvents(db, { designId: design.id });
    expect(claimed.map((event) => [event.payload, event.userId])).toEqual([
      [{ summary: "second\ufffd", seq: 2 }, user.id],
      [{ summary: "first", seq: 1 }, user.id],
    ]);
  });

  test("appends no event when the commit misses, or for an op the log already has", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    await commitOps(db, { designId: design.id, expectedSeq: 0, actor, ops: [rename("a", "One")] });

    const missed = await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor,
      ops: [rename("b", "Two")],
      events: [edit("b", user.id, "missed")],
    });
    const replayed = await commitOps(db, {
      designId: design.id,
      expectedSeq: 1,
      actor,
      ops: [rename("a", "One"), rename("c", "Three", "One")],
      events: [edit("a", user.id, "again"), edit("c", user.id, "new")],
    });

    expect(missed.kind).toBe("conflict");
    expect(replayed).toMatchObject({ kind: "committed", seq: 2, replayed: ["a"] });
    const claimed = await claimEvents(db, { designId: design.id });
    expect(claimed.map((event) => event.payload)).toEqual([{ summary: "new", seq: 2 }]);
  });

  test("an event that cannot be stored fails the whole commit, so the op is not in the log without it", async () => {
    const { design, user } = await seedDesign(db);

    const failed = commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("a", "One")],
      events: [{ ...edit("a", user.id, "x"), userId: "usr_nobody" }],
    });

    await expect(failed).rejects.toThrow();
    expect(await logOf(design.id)).toEqual([]);
    expect((await getDesign(db, design.id))!.seq).toBe(0);
  });

  test("moves the design's name and icon with the ops that changed them", async () => {
    const { design, user } = await seedDesign(db);

    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("a", "Porto")],
      head: { name: "Porto", icon: "star" },
    });
    expect(await getDesign(db, design.id)).toMatchObject({ name: "Porto", icon: "star" });

    await commitOps(db, {
      designId: design.id,
      expectedSeq: 1,
      actor: actorFor(user),
      ops: [rename("b", "Faro", "Porto")],
    });
    expect(await getDesign(db, design.id)).toMatchObject({ name: "Porto", icon: "star" });
  });
});

describe("readOps", () => {
  test("pages through the log from a seq", async () => {
    const { design, user } = await seedDesign(db);
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: ["a", "b", "c", "d", "e"].map((id) => rename(id, id)),
    });

    const first = await readOps(db, { designId: design.id, after: 1, limit: 2 });
    expect(first).toMatchObject({ kind: "ok", seq: 5, ops: [{ seq: 2 }, { seq: 3 }] });
    const rest = await readOps(db, { designId: design.id, after: 3 });
    expect(rest).toMatchObject({ kind: "ok", seq: 5, ops: [{ seq: 4 }, { seq: 5 }] });
  });

  test("stops before the op that would take a page past maxBytes, but always reads one", async () => {
    const { design, user } = await seedDesign(db);
    // Each op's text is a little over 1,000 bytes.
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: ["a", "b", "c", "d"].map((id) => rename(id, id.repeat(1000))),
    });

    const page = await readOps(db, { designId: design.id, after: 0, maxBytes: 2_500 });
    expect(page).toMatchObject({ kind: "ok", seq: 4, ops: [{ seq: 1 }, { seq: 2 }] });
    const tiny = await readOps(db, { designId: design.id, after: 2, maxBytes: 10 });
    expect(tiny).toMatchObject({ kind: "ok", seq: 4, ops: [{ seq: 3 }] });
    const all = await readOps(db, { designId: design.id, after: 0 });
    expect(all).toMatchObject({ kind: "ok", ops: [{}, {}, {}, {}] });
  });

  test("is empty at the head, and past it", async () => {
    const { design, user } = await seedDesign(db);
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor: actorFor(user),
      ops: [rename("a", "One")],
    });

    expect(await readOps(db, { designId: design.id, after: 1 })).toEqual({
      kind: "ok",
      seq: 1,
      ops: [],
    });
    expect(await readOps(db, { designId: design.id, after: 9 })).toEqual({
      kind: "ok",
      seq: 1,
      ops: [],
    });
  });

  test("is null for a design that does not exist", async () => {
    expect(await readOps(db, { designId: "des_missing", after: 0 })).toBeNull();
  });
});

describe("findOps", () => {
  test("finds the ops with the given ids, in this design only", async () => {
    const one = await seedDesign(db);
    const other = await seedDesign(db);
    await commitOps(db, {
      designId: one.design.id,
      expectedSeq: 0,
      actor: actorFor(one.user),
      ops: [rename("a", "One"), rename("b", "Two"), rename("c", "Three")],
    });
    await commitOps(db, {
      designId: other.design.id,
      expectedSeq: 0,
      actor: actorFor(other.user),
      ops: [rename("z", "Elsewhere")],
    });

    const found = await findOps(db, { designId: one.design.id, ids: ["c", "a", "z", "nope"] });

    expect(found.map((op) => [op.id, op.seq])).toEqual([
      ["a", 1],
      ["c", 3],
    ]);
    expect(await findOps(db, { designId: one.design.id, ids: [] })).toEqual([]);
    // An id Postgres could not have stored is simply not there.
    expect(await findOps(db, { designId: one.design.id, ids: ["a\u0000", "b"] })).toMatchObject([
      { id: "b" },
    ]);
  });
});
