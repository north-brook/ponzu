import { describe, expect, test } from "bun:test";
import { applyOp, type Op } from "./doc.ts";
import { el, SAMPLE_OPS, sampleDoc, text, VARIANTS } from "./fixtures/ops.ts";
import {
  MAX_BATCH_DEPTH,
  MAX_ENTRIES,
  MAX_ID_LENGTH,
  MAX_LIST_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NODE_DEPTH,
  MAX_NODES,
  MAX_OP_BYTES,
  MAX_STRING_LENGTH,
} from "./limits.ts";
import type { PElement, PNode } from "./types.ts";
import { InvalidOpError, validateOp } from "./validate.ts";

/** The op as it arrives: parsed from JSON, sharing nothing with the fixture. */
function wire(op: unknown): any {
  return JSON.parse(JSON.stringify(op));
}

/** The path `validateOp` blames, or null when it accepts the input. */
function fault(input: unknown): string | null {
  try {
    validateOp(input);
    return null;
  } catch (err) {
    if (!(err instanceof InvalidOpError)) throw err;
    expect(err.message).toBe(`${err.path} ${err.problem}`);
    return err.path;
  }
}

/** A copy of a variant's sample with one change made to it. */
function broken(variant: Op["op"], change: (op: any) => void): unknown {
  const op = wire(SAMPLE_OPS[variant]);
  change(op);
  return op;
}

describe("every variant", () => {
  for (const variant of VARIANTS) {
    test(`${variant}: the sample is valid, and comes back as it went in`, () => {
      const input = wire(SAMPLE_OPS[variant]);
      const before = JSON.stringify(input);
      expect(validateOp(input)).toBe(input);
      expect(JSON.stringify(input)).toBe(before);
      // What validates also applies: the fixture and the validator agree on the shape.
      applyOp(sampleDoc(), input);
    });

    test(`${variant}: every field is needed, and no other is allowed`, () => {
      const sample = wire(SAMPLE_OPS[variant]);
      const optional = OPTIONAL[variant] ?? [];
      for (const field of Object.keys(sample)) {
        if (field === "op" || optional.includes(field)) continue;
        expect(fault(broken(variant, (op) => delete op[field]))).toBe(`op.${field}`);
        expect(fault(broken(variant, (op) => (op[field] = undefined)))).toBe(`op.${field}`);
      }
      for (const field of optional)
        expect(fault(broken(variant, (op) => delete op[field]))).toBeNull();
      expect(fault(broken(variant, (op) => (op.extra = 1)))).toBe("op.extra");
      // A field set to undefined is absent once the op is JSON, so it isn't an extra one.
      expect(fault(broken(variant, (op) => (op.extra = undefined)))).toBeNull();
    });
  }
});

/** The fields of each sample that its variant can do without. */
const OPTIONAL: Partial<Record<Op["op"], string[]>> = {
  "artboard.update": ["x", "y", "name"],
  "page.update": ["name", "icon"],
  "thread.update": ["status", "nodeId", "offset", "x", "y", "artboardId", "pageId", "updatedAt"],
};

/** Per variant: a change that makes the sample invalid, and the path that should be blamed. */
const INVALID: { [K in Op["op"]]: [change: (op: any) => void, path: string][] } = {
  insert: [
    [(op) => (op.parent = 7), "op.parent"],
    [(op) => (op.parent = "has space"), "op.parent"],
    [(op) => (op.index = -1), "op.index"],
    [(op) => (op.index = 1.5), "op.index"],
    [(op) => (op.index = "0"), "op.index"],
    [(op) => (op.index = null), "op.index"],
    [(op) => (op.nodes = {}), "op.nodes"],
    [(op) => (op.nodes = "<p>"), "op.nodes"],
    [(op) => (op.nodes[0] = null), "op.nodes[0]"],
    [(op) => (op.nodes[0] = [1]), "op.nodes[0]"],
    [(op) => (op.nodes[0].kind = "comment"), "op.nodes[0].kind"],
    [(op) => delete op.nodes[0].kind, "op.nodes[0].kind"],
    [(op) => (op.nodes[0].id = "a b"), "op.nodes[0].id"],
    [(op) => (op.nodes[0].id = 'x" onclick="alert(1)'), "op.nodes[0].id"],
    [(op) => (op.nodes[0].id = ""), "op.nodes[0].id"],
    [(op) => delete op.nodes[0].id, "op.nodes[0].id"],
    [(op) => (op.nodes[0].tag = "div onclick=alert(1)"), "op.nodes[0].tag"],
    [(op) => (op.nodes[0].tag = "img/src=x"), "op.nodes[0].tag"],
    [(op) => (op.nodes[0].tag = ""), "op.nodes[0].tag"],
    [(op) => (op.nodes[0].tag = "1up"), "op.nodes[0].tag"],
    [(op) => (op.nodes[0].ns = "html"), "op.nodes[0].ns"],
    [(op) => (op.nodes[0].name = 3), "op.nodes[0].name"],
    [(op) => delete op.nodes[0].attrs, "op.nodes[0].attrs"],
    [(op) => (op.nodes[0].attrs = []), "op.nodes[0].attrs"],
    [(op) => (op.nodes[0].attrs = { href: 1 }), "op.nodes[0].attrs.href"],
    [(op) => (op.nodes[0].attrs = { "a b": "x" }), 'op.nodes[0].attrs."a b"'],
    [(op) => (op.nodes[0].attrs = { "x=y": "x" }), 'op.nodes[0].attrs."x=y"'],
    [(op) => (op.nodes[0].attrs = { "": "x" }), 'op.nodes[0].attrs.""'],
    [(op) => (op.nodes[0].style = null), "op.nodes[0].style"],
    [(op) => (op.nodes[0].style = { color: null }), "op.nodes[0].style.color"],
    [(op) => (op.nodes[0].style = { "a:b": "x" }), 'op.nodes[0].style."a:b"'],
    [(op) => (op.nodes[0].children = "text"), "op.nodes[0].children"],
    [(op) => (op.nodes[0].children[0].value = 5), "op.nodes[0].children[0].value"],
    [(op) => (op.nodes[0].children[0].tag = "b"), "op.nodes[0].children[0].tag"],
    [(op) => (op.nodes[0].onclick = "x"), "op.nodes[0].onclick"],
  ],
  remove: [
    [(op) => (op.id = null), "op.id"],
    [(op) => (op.id = "x".repeat(MAX_ID_LENGTH + 1)), "op.id"],
    [(op) => (op.id = "n_1/../x"), "op.id"],
  ],
  move: [
    [(op) => (op.parent = ["ab_1"]), "op.parent"],
    [(op) => (op.index = Number.NaN), "op.index"],
    [(op) => (op.index = Number.POSITIVE_INFINITY), "op.index"],
  ],
  style: [
    [(op) => (op.style = "color:red"), "op.style"],
    [(op) => (op.style = { color: 3 }), "op.style.color"],
    [(op) => (op.style = { "col or": "red" }), 'op.style."col or"'],
    [(op) => (op.style = { "x;y": "red" }), 'op.style."x;y"'],
  ],
  attrs: [
    [(op) => (op.attrs = null), "op.attrs"],
    [(op) => (op.attrs = { title: ["x"] }), "op.attrs.title"],
    [(op) => (op.attrs = { 'a"b': "x" }), 'op.attrs."a\\"b"'],
    [(op) => (op.attrs = { "a>b": "x" }), 'op.attrs."a>b"'],
  ],
  name: [
    [(op) => (op.name = 1), "op.name"],
    [(op) => (op.name = "n".repeat(MAX_NAME_LENGTH + 1)), "op.name"],
    [(op) => (op.id = undefined), "op.id"],
  ],
  children: [
    [(op) => (op.children = null), "op.children"],
    [(op) => (op.children[0] = "text"), "op.children[0]"],
    [(op) => delete op.children[0].value, "op.children[0].value"],
    [(op) => (op.children[1].children = [{ kind: "text" }]), "op.children[1].children[0].value"],
  ],
  "artboard.create": [
    [(op) => (op.page = 1), "op.page"],
    [(op) => (op.artboard = null), "op.artboard"],
    [(op) => (op.artboard.x = "0"), "op.artboard.x"],
    [(op) => (op.artboard.y = Number.NaN), "op.artboard.y"],
    [(op) => delete op.artboard.name, "op.artboard.name"],
    [(op) => (op.artboard.root = text("x")), "op.artboard.root.kind"],
    [(op) => (op.artboard.root.id = "ab_other"), "op.artboard.root.id"],
    [(op) => (op.artboard.root.tag = "sec tion"), "op.artboard.root.tag"],
    [(op) => (op.artboard.thumb = "x"), "op.artboard.thumb"],
  ],
  "artboard.delete": [
    [(op) => (op.id = {}), "op.id"],
    [(op) => (op.id = "ab 1"), "op.id"],
  ],
  "artboard.update": [
    [(op) => (op.x = "40"), "op.x"],
    [(op) => (op.y = Number.NEGATIVE_INFINITY), "op.y"],
    [(op) => (op.name = null), "op.name"],
  ],
  "artboard.move": [
    [(op) => (op.page = "pg 2"), "op.page"],
    [(op) => (op.index = -3), "op.index"],
  ],
  "page.create": [
    [(op) => (op.page = "pg_3"), "op.page"],
    [(op) => (op.page.id = "../etc"), "op.page.id"],
    [(op) => delete op.page.name, "op.page.name"],
    [(op) => (op.page.icon = null), "op.page.icon"],
    [(op) => (op.page.artboards = []), "op.page.artboards"],
  ],
  "page.delete": [
    [(op) => (op.id = 0), "op.id"],
    [(op) => (op.id = "pg\n1"), "op.id"],
  ],
  "page.update": [
    [(op) => (op.name = false), "op.name"],
    [(op) => (op.icon = 4), "op.icon"],
    [(op) => (op.icon = "i".repeat(MAX_NAME_LENGTH + 1)), "op.icon"],
  ],
  "page.order": [
    [(op) => (op.ids = "pg_1"), "op.ids"],
    [(op) => (op.ids[1] = 2), "op.ids[1]"],
    [(op) => (op.ids = new Array(MAX_LIST_LENGTH + 1).fill("pg_1")), "op.ids"],
  ],
  "page.move": [
    [(op) => (op.index = "last"), "op.index"],
    [(op) => (op.id = "pg.1"), "op.id"],
  ],
  "file.rename": [
    [(op) => (op.name = null), "op.name"],
    [(op) => (op.name = "n".repeat(MAX_NAME_LENGTH + 1)), "op.name"],
  ],
  "file.icon": [
    [(op) => (op.icon = 1), "op.icon"],
    [(op) => (op.icon = { name: "star" }), "op.icon"],
  ],
  "file.scratch": [
    [(op) => (op.scratch = "true"), "op.scratch"],
    [(op) => (op.scratch = null), "op.scratch"],
  ],
  tokens: [
    [(op) => (op.css = null), "op.css"],
    [(op) => (op.css = { "--ink": "#000" }), "op.css"],
    [(op) => (op.css = "x".repeat(MAX_STRING_LENGTH + 1)), "op.css"],
  ],
  "thread.create": [
    [(op) => (op.thread = []), "op.thread"],
    [(op) => (op.thread.id = "th 2"), "op.thread.id"],
    [(op) => delete op.thread.pageId, "op.thread"],
    [(op) => (op.thread.status = "closed"), "op.thread.status"],
    [(op) => (op.thread.x = null), "op.thread.x"],
    [(op) => (op.thread.createdAt = "2026-01-01"), "op.thread.createdAt"],
    [(op) => (op.thread.updatedAt = -1), "op.thread.updatedAt"],
    [(op) => (op.thread.offset = { x: 1 }), "op.thread.offset.y"],
    [(op) => (op.thread.nodeId = null), "op.thread.nodeId"],
    [(op) => (op.thread.messages = null), "op.thread.messages"],
    [(op) => (op.thread.messages[0].author = "Ada"), "op.thread.messages[0].author"],
    [(op) => (op.thread.messages[0].author.kind = "admin"), "op.thread.messages[0].author.kind"],
    [(op) => delete op.thread.messages[0].author.name, "op.thread.messages[0].author.name"],
    [(op) => (op.thread.messages[0].author.role = "x"), "op.thread.messages[0].author.role"],
    [(op) => (op.thread.messages[0].text = 1), "op.thread.messages[0].text"],
    [(op) => (op.thread.messages[0].id = "m 2"), "op.thread.messages[0].id"],
    [(op) => (op.thread.messages[0].editedAt = null), "op.thread.messages[0].editedAt"],
    [
      (op) => (op.thread.messages = new Array(MAX_LIST_LENGTH + 1).fill(op.thread.messages[0])),
      "op.thread.messages",
    ],
  ],
  "thread.delete": [
    [(op) => (op.id = true), "op.id"],
    [(op) => (op.id = "th_1 "), "op.id"],
  ],
  "thread.update": [
    [(op) => (op.status = "done"), "op.status"],
    [(op) => (op.status = null), "op.status"],
    [(op) => (op.nodeId = 5), "op.nodeId"],
    [(op) => (op.offset = { x: "3", y: 4 }), "op.offset.x"],
    [(op) => (op.offset = [3, 4]), "op.offset"],
    [(op) => (op.x = null), "op.x"],
    [(op) => (op.artboardId = "ab 1"), "op.artboardId"],
    [(op) => (op.pageId = {}), "op.pageId"],
    [(op) => (op.updatedAt = "now"), "op.updatedAt"],
    [(op) => (op.updatedAt = 1.5), "op.updatedAt"],
    [(op) => (op.createdAt = 1), "op.createdAt"],
  ],
  "thread.message": [
    [(op) => (op.message = "Yes."), "op.message"],
    [(op) => delete op.message.author, "op.message.author"],
    [(op) => (op.message.author.id = "user id"), "op.message.author.id"],
    [(op) => (op.message.createdAt = null), "op.message.createdAt"],
    [(op) => (op.message.text = "x".repeat(MAX_STRING_LENGTH + 1)), "op.message.text"],
  ],
  "thread.unmessage": [
    [(op) => (op.messageId = 1), "op.messageId"],
    [(op) => (op.messageId = "m/1"), "op.messageId"],
  ],
  "thread.edit": [
    [(op) => (op.text = null), "op.text"],
    [(op) => (op.editedAt = "5000"), "op.editedAt"],
    [(op) => delete op.editedAt, "op.editedAt"],
    [(op) => (op.messageId = ""), "op.messageId"],
  ],
  note: [
    [(op) => (op.name = "../../etc/passwd"), "op.name"],
    [(op) => (op.name = "with space"), "op.name"],
    [(op) => (op.name = ""), "op.name"],
    [(op) => (op.name = "__proto__"), "op.name"],
    [(op) => (op.name = "constructor"), "op.name"],
    [(op) => (op.name = "toString"), "op.name"],
    [(op) => (op.content = 1), "op.content"],
    [(op) => delete op.content, "op.content"],
  ],
  batch: [
    [(op) => (op.ops = null), "op.ops"],
    [(op) => (op.ops = { 0: op.ops[0] }), "op.ops"],
    [(op) => (op.ops[0] = "style"), "op.ops[0]"],
    [(op) => (op.ops[0].op = "restyle"), "op.ops[0].op"],
    [(op) => (op.ops[0].style = { color: 1 }), "op.ops[0].style.color"],
    [(op) => (op.ops[1].ops[0].name = 1), "op.ops[1].ops[0].name"],
    [(op) => (op.ops = new Array(MAX_LIST_LENGTH + 1).fill(op.ops[0])), "op.ops"],
  ],
};

describe("what each variant refuses", () => {
  for (const variant of VARIANTS) {
    test(variant, () => {
      expect(INVALID[variant].length).toBeGreaterThanOrEqual(2);
      for (const [change, path] of INVALID[variant])
        expect(fault(broken(variant, change))).toBe(path);
    });
  }
});

describe("what isn't an op at all", () => {
  test.each([
    [null, "op"],
    [undefined, "op"],
    ["insert", "op"],
    [42, "op"],
    [[], "op"],
    [[{ op: "remove", id: "n_1" }], "op"],
    [{}, "op.op"],
    [{ op: null }, "op.op"],
    [{ op: 1 }, "op.op"],
    [{ op: ["remove"] }, "op.op"],
    [{ op: "explode", id: "n_1" }, "op.op"],
    [{ op: "Remove", id: "n_1" }, "op.op"],
    [{ op: "" }, "op.op"],
  ])("%j", (input, path) => {
    expect(fault(input)).toBe(path);
  });

  test("an op named after something every object has", () => {
    for (const op of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])
      expect(fault({ op, id: "n_1" })).toBe("op.op");
  });
});

describe("hostile input", () => {
  test("__proto__ is refused wherever it's a key, and pollutes nothing", () => {
    const inputs = [
      '{"op":"remove","id":"n_1","__proto__":{"polluted":true}}',
      '{"op":"style","id":"n_1","style":{"__proto__":"red"}}',
      '{"op":"attrs","id":"n_1","attrs":{"__proto__":"x"}}',
      '{"op":"insert","parent":"n_1","index":0,"nodes":[{"kind":"el","id":"n_9","tag":"p","attrs":{},"style":{},"children":[],"__proto__":{"polluted":true}}]}',
      '{"op":"thread.update","id":"th_1","offset":{"x":1,"y":2,"__proto__":{"polluted":true}}}',
      '{"op":"note","name":"__proto__","content":"x"}',
      '{"op":"batch","ops":[],"constructor":{"prototype":{"polluted":true}}}',
    ];
    for (const json of inputs) expect(fault(JSON.parse(json))).not.toBeNull();
    expect(({} as any).polluted).toBeUndefined();
    expect(fault(JSON.parse(inputs[1]!))).toBe("op.style.__proto__");
    expect(fault(JSON.parse(inputs[2]!))).toBe("op.attrs.__proto__");
  });

  test("nodes nested past the limit are refused before anything walks them", () => {
    const nest = (depth: number): PElement => {
      let node = el("n_0", "div");
      for (let i = 1; i < depth; i++) node = el(`n_${i}`, "div", [node]);
      return node;
    };
    const insert = (node: PNode) => ({ op: "insert", parent: "n_1", index: 0, nodes: [node] });
    expect(fault(insert(nest(MAX_NODE_DEPTH)))).toBeNull();
    expect(fault(insert(nest(MAX_NODE_DEPTH + 1)))).toMatch(/children$/);
    // Deep enough to overflow the stack of anything that recursed into it.
    expect(fault(insert(nest(200_000)))).toMatch(/children$/);
    // An artboard's root is the first level.
    const board = (root: PElement) => ({
      op: "artboard.create",
      page: "pg_1",
      index: 0,
      artboard: { id: root.id, name: "A", x: 0, y: 0, root },
    });
    expect(fault(board(nest(MAX_NODE_DEPTH)))).toBeNull();
    expect(fault(board(nest(MAX_NODE_DEPTH + 1)))).toMatch(/children$/);
  });

  test("batches nested past the limit are refused", () => {
    const nest = (depth: number): Op => {
      let op: Op = { op: "remove", id: "n_1" };
      for (let i = 0; i < depth; i++) op = { op: "batch", ops: [op] };
      return op;
    };
    expect(fault(nest(MAX_BATCH_DEPTH))).toBeNull();
    expect(fault(nest(MAX_BATCH_DEPTH + 1))).toBe(`op${".ops[0]".repeat(MAX_BATCH_DEPTH)}`);
    expect(fault(nest(200_000))).toBe(`op${".ops[0]".repeat(MAX_BATCH_DEPTH)}`);
  });

  test("more nodes than an op may carry are refused, however they're spread", () => {
    const many = (count: number) => Array.from({ length: count }, () => text("x"));
    const children = (nodes: PNode[]) => ({ op: "children", id: "n_1", children: nodes });
    expect(fault(children(many(MAX_NODES)))).toBeNull();
    expect(fault(children(many(MAX_NODES + 1)))).toBe("op.children");
    // One huge list is turned away by its length, without a look at what's in it.
    const huge = new Array(5_000_000).fill(null);
    expect(fault(children(huge as PNode[]))).toBe("op.children");
    // Across the ops of a batch, the count is one count.
    const half = children(many(MAX_NODES / 2));
    expect(fault({ op: "batch", ops: [half, half] })).toBeNull();
    expect(fault({ op: "batch", ops: [half, half, children([text("x")])] })).toBe(
      "op.ops[2].children",
    );
    // And through the levels of a tree.
    const wide = el("n_w", "div", many(MAX_NODES - 1));
    expect(fault({ op: "insert", parent: "n_1", index: 0, nodes: [wide] })).toBeNull();
    wide.children.push(text("one more"));
    expect(fault({ op: "insert", parent: "n_1", index: 0, nodes: [wide] })).toBe(
      "op.nodes[0].children",
    );
  });

  test("an element with too many attributes or declarations is refused", () => {
    const map = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`data-a${i}`, "x"]));
    expect(fault({ op: "attrs", id: "n_1", attrs: map(MAX_ENTRIES) })).toBeNull();
    expect(fault({ op: "attrs", id: "n_1", attrs: map(MAX_ENTRIES + 1) })).toBe("op.attrs");
    expect(fault({ op: "style", id: "n_1", style: map(MAX_ENTRIES + 1) })).toBe("op.style");
  });

  test("strings and names past their limits are refused", () => {
    const long = "x".repeat(MAX_STRING_LENGTH + 1);
    expect(fault({ op: "children", id: "n_1", children: [text(long.slice(1))] })).toBeNull();
    expect(fault({ op: "children", id: "n_1", children: [text(long)] })).toBe(
      "op.children[0].value",
    );
    expect(fault({ op: "attrs", id: "n_1", attrs: { src: long } })).toBe("op.attrs.src");
    expect(fault({ op: "style", id: "n_1", style: { background: long } })).toBe(
      "op.style.background",
    );
    expect(fault({ op: "note", name: "brief", content: long })).toBe("op.content");
    const name = "n".repeat(MAX_NAME_LENGTH + 1);
    expect(fault({ op: "attrs", id: "n_1", attrs: { [name]: "x" } })).toMatch(/^op\.attrs\./);
    expect(fault({ op: "insert", parent: "n_1", index: 0, nodes: [el("n_9", name)] })).toBe(
      "op.nodes[0].tag",
    );
    // The path stays short whatever the key was.
    expect(fault({ op: "attrs", id: "n_1", attrs: { [name]: "x" } })!.length).toBeLessThan(80);
  });

  test("an op past the size limit is refused, counted in bytes", () => {
    const strings = (count: number, fill: string) =>
      Array.from({ length: count }, () => text(fill.repeat(MAX_STRING_LENGTH / 2)));
    const children = (nodes: PNode[]) => ({ op: "children", id: "n_1", children: nodes });
    expect(fault(children(strings(7, "x")))).toBeNull();
    expect(JSON.stringify(children(strings(9, "x"))).length).toBeGreaterThan(MAX_OP_BYTES);
    expect(fault(children(strings(9, "x")))).toBe("op");
    // Three bytes a character: under the limit in characters, over it in bytes.
    const wide = children(strings(4, "€"));
    expect(JSON.stringify(wide).length).toBeLessThan(MAX_OP_BYTES);
    expect(fault(wide)).toBe("op");
  });

  test("numbers JSON can't carry are refused too", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null]) {
      expect(fault({ op: "artboard.update", id: "ab_1", x: bad })).toBe("op.x");
      expect(fault({ op: "move", id: "n_2", parent: "n_1", index: bad })).toBe("op.index");
    }
    expect(fault({ op: "move", id: "n_2", parent: "n_1", index: 2 ** 53 })).toBe("op.index");
  });
});
