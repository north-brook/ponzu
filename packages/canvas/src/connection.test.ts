import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Doc, emptyDoc, type ServerMessage } from "@ponzu/core";
import { SocketSource } from "./connection.ts";

/** A WebSocket the test plays the server for: it hears what the canvas sends. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 1;
  sent: unknown[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {}
  hear(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const real = globalThis.WebSocket;
beforeEach(() => {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  globalThis.WebSocket = real;
});

function doc(): Doc {
  const d = emptyDoc("Kettle");
  d.pages.push({ id: "pg_a", name: "Home", artboards: [] });
  return d;
}

const page = (id: string, name: string, seq: number): ServerMessage => ({
  t: "op",
  seq,
  op: { op: "page.create", index: 9, page: { id, name } },
  origin: { kind: "agent", name: "Claude" },
  canUndo: true,
  canRedo: false,
});

function open(opts: { watch?: boolean } = {}) {
  const source = new SocketSource("http://127.0.0.1:7777", "/k.design", opts);
  const socket = FakeSocket.last;
  socket.hear({
    t: "hello",
    doc: doc(),
    seq: 3,
    path: "/k.design",
    presence: [],
    canUndo: false,
    canRedo: false,
  });
  return { source, socket, pages: () => source.getState().doc!.pages.map((p) => p.id) };
}

test("ops that follow on are applied, and ask for nothing", () => {
  const { socket, pages } = open();
  socket.hear(page("pg_b", "Two", 4));
  socket.hear(page("pg_c", "Three", 5));
  expect(pages()).toEqual(["pg_a", "pg_b", "pg_c"]);
  expect(socket.sent).toEqual([]);
});

test("a canvas that missed an op asks for the whole doc, and catches up on it", () => {
  const { socket, pages } = open({ watch: true });
  socket.hear(page("pg_c", "Three", 5));
  expect(socket.sent).toEqual([{ t: "sync", reason: "gap" }]);
  expect(pages()).toEqual(["pg_a"]);

  // Ops while it waits are on a doc it doesn't have: held off, and not asked for twice.
  socket.hear(page("pg_d", "Four", 6));
  expect(socket.sent).toHaveLength(1);
  expect(pages()).toEqual(["pg_a"]);

  const caught = doc();
  for (const [id, name] of [
    ["pg_b", "Two"],
    ["pg_c", "Three"],
    ["pg_d", "Four"],
  ] as const)
    caught.pages.push({ id, name, artboards: [] });
  socket.hear({ t: "reset", doc: caught, seq: 6 });
  expect(pages()).toEqual(["pg_a", "pg_b", "pg_c", "pg_d"]);
  socket.hear(page("pg_e", "Five", 7));
  expect(pages()).toEqual(["pg_a", "pg_b", "pg_c", "pg_d", "pg_e"]);
  expect(socket.sent).toHaveLength(1);
});

test("an op that doesn't fit the doc asks for the whole doc", () => {
  const { socket, pages } = open();
  socket.hear({
    t: "op",
    seq: 4,
    op: { op: "artboard.update", id: "ab_never_heard_of", name: "X" },
    origin: { kind: "disk", name: "pages/home/x.html" },
    canUndo: false,
    canRedo: false,
  });
  expect(socket.sent).toEqual([{ t: "sync", reason: "apply" }]);
  expect(pages()).toEqual(["pg_a"]);
});
