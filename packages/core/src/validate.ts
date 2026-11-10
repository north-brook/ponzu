import type { Op } from "./doc.ts";
import {
  MAX_BATCH_DEPTH,
  MAX_ENTRIES,
  MAX_LIST_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NODE_DEPTH,
  MAX_NODES,
  MAX_OP_BYTES,
  MAX_STRING_LENGTH,
} from "./limits.ts";
import { isAttributeName, isId, isStyleProperty, isTagName } from "./rules.ts";

/** An op that isn't one. `path` names the field at fault, like `op.nodes[0].attrs.href`. */
export class InvalidOpError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${path} ${problem}`);
    this.name = "InvalidOpError";
  }
}

/**
 * Check that untrusted JSON is an op: a known variant with every field it needs, nothing it
 * doesn't, the right types, well-formed ids and names, and sizes within limits.ts. Returns
 * the input itself, typed, or throws `InvalidOpError`.
 *
 * This is the shape only. Whether the op fits a design is `applyOp`'s to say, and what its
 * nodes may hold is `sanitizeOp`'s.
 */
export function validateOp(input: unknown): Op {
  const budget = { nodes: MAX_NODES };
  checkOp(input, "op", 0, budget);
  // Measured last: by now the op is known to be shallow enough to serialize.
  const bytes = utf8Length(JSON.stringify(input));
  if (bytes > MAX_OP_BYTES) fail("op", `is ${bytes} bytes; the most is ${MAX_OP_BYTES}`);
  return input as Op;
}

type Fields = Record<string, unknown>;
type Check = (value: unknown, path: string) => void;

/** How many more nodes the op may carry. */
interface Budget {
  nodes: number;
}

function checkOp(input: unknown, path: string, depth: number, budget: Budget): void {
  const kind = typeof input === "object" && input !== null ? (input as Fields).op : undefined;
  if (typeof kind !== "string") {
    record(input, path);
    fail(`${path}.op`, "must name an op");
  }
  // Looked up as an own key, so "constructor" and its kind name no variant.
  const check = Object.hasOwn(VARIANTS, kind) ? VARIANTS[kind as Op["op"]] : undefined;
  if (!check) fail(`${path}.op`, `is not an op Ponzu knows: ${JSON.stringify(kind.slice(0, 40))}`);
  check(input as Fields, path, depth, budget);
}

const VARIANTS: Record<
  Op["op"],
  (op: Fields, path: string, depth: number, budget: Budget) => void
> = {
  insert: (op, path, _depth, budget) => {
    fields(op, path, { op: any, parent: id, index, nodes: (v, p) => nodes(v, p, 1, budget) });
  },
  remove: (op, path) => fields(op, path, { op: any, id }),
  move: (op, path) => fields(op, path, { op: any, id, parent: id, index }),
  style: (op, path) => fields(op, path, { op: any, id, style }),
  attrs: (op, path) => fields(op, path, { op: any, id, attrs }),
  name: (op, path) => fields(op, path, { op: any, id, name: nullable(name) }),
  children: (op, path, _depth, budget) => {
    fields(op, path, { op: any, id, children: (v, p) => nodes(v, p, 1, budget) });
  },
  "artboard.create": (op, path, _depth, budget) => {
    fields(op, path, { op: any, page: id, index, artboard: (v, p) => artboard(v, p, budget) });
  },
  "artboard.delete": (op, path) => fields(op, path, { op: any, id }),
  "artboard.update": (op, path) => {
    fields(op, path, { op: any, id }, { x: number, y: number, name });
  },
  "artboard.move": (op, path) => fields(op, path, { op: any, id, page: id, index }),
  "page.create": (op, path) => fields(op, path, { op: any, index, page }),
  "page.delete": (op, path) => fields(op, path, { op: any, id }),
  "page.update": (op, path) => {
    fields(op, path, { op: any, id }, { name, icon: nullable(name) });
  },
  "page.order": (op, path) => fields(op, path, { op: any, ids: list(id) }),
  "page.move": (op, path) => fields(op, path, { op: any, id, index }),
  "file.rename": (op, path) => fields(op, path, { op: any, name }),
  "file.icon": (op, path) => fields(op, path, { op: any, icon: nullable(name) }),
  "file.scratch": (op, path) => fields(op, path, { op: any, scratch: boolean }),
  tokens: (op, path) => fields(op, path, { op: any, css: string }),
  "thread.create": (op, path) => fields(op, path, { op: any, thread }),
  "thread.delete": (op, path) => fields(op, path, { op: any, id }),
  "thread.update": (op, path) => {
    fields(
      op,
      path,
      { op: any, id },
      {
        status,
        nodeId: nullable(id),
        offset: nullable(point),
        x: number,
        y: number,
        artboardId: nullable(id),
        pageId: nullable(id),
        updatedAt: time,
      },
    );
  },
  "thread.message": (op, path) => fields(op, path, { op: any, id, message }),
  "thread.unmessage": (op, path) => fields(op, path, { op: any, id, messageId: id }),
  "thread.edit": (op, path) => {
    fields(op, path, { op: any, id, messageId: id, text: string, editedAt: nullable(time) });
  },
  note: (op, path) => fields(op, path, { op: any, name: noteName, content: nullable(string) }),
  batch: (op, path, depth, budget) => {
    if (depth >= MAX_BATCH_DEPTH) fail(path, `nests batches more than ${MAX_BATCH_DEPTH} deep`);
    fields(op, path, {
      op: any,
      ops: (value, p) => {
        const ops = array(value, p, MAX_LIST_LENGTH);
        ops.forEach((child, i) => checkOp(child, `${p}[${i}]`, depth + 1, budget));
      },
    });
  },
};

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

function nodes(value: unknown, path: string, depth: number, budget: Budget): void {
  // Checked before the walk, so a list of a million nodes costs nothing to turn away.
  const list = array(value, path, budget.nodes, `holds more nodes than an op may (${MAX_NODES})`);
  budget.nodes -= list.length;
  if (list.length && depth > MAX_NODE_DEPTH)
    fail(path, `nests nodes more than ${MAX_NODE_DEPTH} deep`);
  list.forEach((child, i) => node(child, `${path}[${i}]`, depth, budget));
}

function node(value: unknown, path: string, depth: number, budget: Budget): void {
  const kind = record(value, path).kind;
  if (kind === "text") fields(value, path, { kind: any, value: string });
  else if (kind === "el") element(value, path, depth, budget);
  else fail(`${path}.kind`, 'must be "el" or "text"');
}

function element(value: unknown, path: string, depth: number, budget: Budget): void {
  fields(
    value,
    path,
    {
      kind: (v, p) => v === "el" || fail(p, 'must be "el"'),
      id,
      tag: (v, p) => isTagName(name(v, p)) || fail(p, "must be a tag name"),
      attrs,
      style,
      children: (v, p) => nodes(v, p, depth + 1, budget),
    },
    { ns: (v, p) => v === "svg" || v === "math" || fail(p, 'must be "svg" or "math"'), name },
  );
}

function attrs(value: unknown, path: string): void {
  entries(value, path, isAttributeName, "is not an attribute name");
}

function style(value: unknown, path: string): void {
  entries(value, path, isStyleProperty, "is not a CSS property");
}

/** A map of names to strings: an element's attributes or its style. */
function entries(
  value: unknown,
  path: string,
  named: (key: string) => boolean,
  problem: string,
): void {
  const map = record(value, path);
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) fail(path, `has more than ${MAX_ENTRIES} entries`);
  for (const key of keys) {
    const at = `${path}.${show(key)}`;
    if (key.length > MAX_NAME_LENGTH || !named(key)) fail(at, problem);
    string(map[key], at);
  }
}

function artboard(value: unknown, path: string, budget: Budget): void {
  budget.nodes -= 1;
  const board = fields(value, path, {
    id,
    name,
    x: number,
    y: number,
    root: (v, p) => element(v, p, 1, budget),
  });
  if ((board.root as Fields).id !== board.id) fail(`${path}.root.id`, "must be the artboard's id");
}

/* ------------------------------------------------------------------ */
/* Pages and threads                                                   */
/* ------------------------------------------------------------------ */

function page(value: unknown, path: string): void {
  fields(value, path, { id, name }, { icon: name });
}

function thread(value: unknown, path: string): void {
  const t = fields(
    value,
    path,
    {
      id,
      x: number,
      y: number,
      status,
      createdAt: time,
      updatedAt: time,
      messages: list(message),
    },
    { artboardId: id, pageId: id, nodeId: id, offset: point },
  );
  if (t.artboardId === undefined && t.pageId === undefined)
    fail(path, "must be on an artboard (artboardId) or a page (pageId)");
}

function message(value: unknown, path: string): void {
  fields(value, path, { id, author, text: string, createdAt: time }, { editedAt: time });
}

function author(value: unknown, path: string): void {
  fields(value, path, { kind: actorKind, name }, { id, avatarUrl: string });
}

function actorKind(value: unknown, path: string): void {
  if (value !== "user" && value !== "agent") fail(path, 'must be "user" or "agent"');
}

function status(value: unknown, path: string): void {
  if (value !== "open" && value !== "resolved") fail(path, 'must be "open" or "resolved"');
}

function point(value: unknown, path: string): void {
  fields(value, path, { x: number, y: number });
}

function noteName(value: unknown, path: string): void {
  // A note is a key in `doc.notes`, so its name can't be one every object already has.
  if (!/^[\w-]+$/.test(name(value, path)) || (value as string) in Object.prototype)
    fail(path, "must be letters, numbers, dashes and underscores");
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

function fail(path: string, problem: string): never {
  throw new InvalidOpError(path, problem);
}

/** A field checked elsewhere: the discriminant that chose this check. */
function any(): void {}

function record(value: unknown, path: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "must be an object");
  return value as Fields;
}

/**
 * An object with exactly these fields: every `required` one, any of the `optional` ones, and
 * no others. A field set to undefined counts as absent, as it is once the op is JSON.
 */
function fields(
  value: unknown,
  path: string,
  required: Record<string, Check>,
  optional: Record<string, Check> = {},
): Fields {
  const object = record(value, path);
  for (const key of Object.keys(object)) {
    if (object[key] === undefined) continue;
    const check = Object.hasOwn(required, key)
      ? required[key]
      : Object.hasOwn(optional, key)
        ? optional[key]
        : undefined;
    if (!check) fail(`${path}.${show(key)}`, "is not a field here");
    check(object[key], `${path}.${key}`);
  }
  for (const key of Object.keys(required))
    if (object[key] === undefined) fail(`${path}.${key}`, "is missing");
  return object;
}

function array(value: unknown, path: string, max: number, problem?: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be a list");
  if (value.length > max) fail(path, problem ?? `has more than ${max} items`);
  return value;
}

function list(item: Check): Check {
  return (value, path) => {
    array(value, path, MAX_LIST_LENGTH).forEach((v, i) => item(v, `${path}[${i}]`));
  };
}

function nullable(check: Check): Check {
  return (value, path) => {
    if (value !== null) check(value, path);
  };
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > MAX_STRING_LENGTH)
    fail(path, `is longer than ${MAX_STRING_LENGTH} characters`);
  return value;
}

function name(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > MAX_NAME_LENGTH) fail(path, `is longer than ${MAX_NAME_LENGTH} characters`);
  return value;
}

function id(value: unknown, path: string): void {
  if (typeof value !== "string" || !isId(value))
    fail(path, "must be an id: up to 64 letters, numbers, dashes and underscores");
}

function number(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a number");
}

/** A place in a list. `applyOp` clamps it to the list, so past the end means the end. */
function index(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(path, "must be a whole number, 0 or more");
}

/** Milliseconds since 1970. */
function time(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(path, "must be a time in milliseconds");
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") fail(path, "must be true or false");
}

/** A key as part of a path, short enough to read and safe to print. */
function show(key: string): string {
  return /^[\w-]{1,40}$/.test(key) ? key : JSON.stringify(key.slice(0, 40));
}

/** The length of a string in UTF-8, without building the bytes. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    // A surrogate pair is four bytes, counted as two for each half.
    else if (c >= 0xd800 && c <= 0xdfff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}
