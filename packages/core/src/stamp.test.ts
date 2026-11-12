import { describe, expect, test } from "bun:test";
import type { Op } from "./doc.ts";
import { SAMPLE_OPS, VARIANTS } from "./fixtures/ops.ts";
import { authorOf, stampOp } from "./stamp.ts";
import type { Actor } from "./types.ts";

const ada: Actor = { kind: "user", id: "user_01", name: "Ada", avatarUrl: "https://a.test/ada" };
const claude: Actor = { kind: "agent", id: "agent_7", name: "Claude" };
const AT = 1_800_000_000_000;

/** Someone else, some other time: what a client would send to pass for them. */
const forged = { kind: "user" as const, name: "Grace", id: "user_99", avatarUrl: "https://x" };

describe("stampOp", () => {
  test("a new thread is the actor's, now, in every message", () => {
    const op: Op = {
      op: "thread.create",
      thread: {
        id: "th_9",
        artboardId: "ab_1",
        x: 1,
        y: 2,
        status: "open",
        createdAt: 5,
        updatedAt: 99_999_999_999_999,
        messages: [
          { id: "m_1", author: forged, text: "First", createdAt: 5 },
          { id: "m_2", author: forged, text: "Second", createdAt: 6, editedAt: 7 },
        ],
      },
    };
    expect(stampOp(op, ada, AT)).toEqual({
      op: "thread.create",
      thread: {
        id: "th_9",
        artboardId: "ab_1",
        x: 1,
        y: 2,
        status: "open",
        createdAt: AT,
        updatedAt: AT,
        messages: [
          { id: "m_1", author: authorOf(ada), text: "First", createdAt: AT },
          { id: "m_2", author: authorOf(ada), text: "Second", createdAt: AT },
        ],
      },
    });
  });

  test("a message is the actor's, now, and not yet edited", () => {
    const op: Op = {
      op: "thread.message",
      id: "th_1",
      message: { id: "m_3", author: forged, text: "Hi", createdAt: 1, editedAt: 2 },
    };
    expect(stampOp(op, claude, AT)).toEqual({
      op: "thread.message",
      id: "th_1",
      message: {
        id: "m_3",
        author: { kind: "agent", name: "Claude", id: "agent_7" },
        text: "Hi",
        createdAt: AT,
      },
    });
  });

  test("an edit is marked now, even when the client asked for no mark", () => {
    const edit = (editedAt: number | null): Op => ({
      op: "thread.edit",
      id: "th_1",
      messageId: "m_1",
      text: "Changed",
      editedAt,
    });
    expect(stampOp(edit(1), ada, AT)).toEqual(edit(AT));
    expect(stampOp(edit(null), ada, AT)).toEqual(edit(AT));
  });

  test("a thread update is timed now, whether or not the client timed it", () => {
    expect(stampOp({ op: "thread.update", id: "th_1", status: "resolved" }, ada, AT)).toEqual({
      op: "thread.update",
      id: "th_1",
      status: "resolved",
      updatedAt: AT,
    });
    expect(stampOp({ op: "thread.update", id: "th_1", x: 4, updatedAt: 1 }, ada, AT)).toEqual({
      op: "thread.update",
      id: "th_1",
      x: 4,
      updatedAt: AT,
    });
  });

  test("a batch is stamped all the way down", () => {
    const op: Op = {
      op: "batch",
      ops: [
        { op: "file.rename", name: "X" },
        { op: "batch", ops: [{ op: "thread.update", id: "th_1", status: "open", updatedAt: 3 }] },
      ],
    };
    expect(stampOp(op, ada, AT)).toEqual({
      op: "batch",
      ops: [
        { op: "file.rename", name: "X" },
        { op: "batch", ops: [{ op: "thread.update", id: "th_1", status: "open", updatedAt: AT }] },
      ],
    });
  });

  test("every other variant comes back as it is", () => {
    const stamped = new Set<Op["op"]>([
      "thread.create",
      "thread.message",
      "thread.edit",
      "thread.update",
      "batch",
    ]);
    for (const variant of VARIANTS) {
      const op = SAMPLE_OPS[variant];
      if (!stamped.has(variant)) expect(stampOp(op, ada, AT)).toBe(op);
    }
  });

  test("the op it was given is left alone, and keeps its key order where nothing changed", () => {
    for (const variant of VARIANTS) {
      const op = structuredClone(SAMPLE_OPS[variant]) as Op;
      const before = JSON.stringify(op);
      const once = stampOp(op, ada, AT);
      expect(JSON.stringify(op)).toBe(before);
      // Stamped again with the same actor and time, nothing moves: not even a key.
      expect(JSON.stringify(stampOp(once, ada, AT))).toBe(JSON.stringify(once));
    }
  });

  test("an author carries the actor's id, and an avatar only when there is one", () => {
    expect(authorOf(ada)).toEqual({
      kind: "user",
      name: "Ada",
      id: "user_01",
      avatarUrl: "https://a.test/ada",
    });
    expect(Object.keys(authorOf(claude))).toEqual(["kind", "name", "id"]);
  });
});
