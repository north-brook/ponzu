import { type Doc, findArtboard, locate, type Op } from "./doc.ts";
import type { Thread } from "./types.ts";

/** What an op did to a comment thread, for telling people and agents about it. */
export type ThreadEvent =
  | { kind: "created"; thread: Thread }
  | { kind: "message"; id: string; text: string }
  | { kind: "edited"; id: string; text: string }
  | { kind: "status"; id: string; status: Thread["status"] };

/** The comment events in an op, in order: a new thread, a reply, an edit, resolved or reopened. */
export function threadEvents(op: Op): ThreadEvent[] {
  if (op.op === "batch") return op.ops.flatMap(threadEvents);
  if (op.op === "thread.create") return [{ kind: "created", thread: op.thread }];
  if (op.op === "thread.message") return [{ kind: "message", id: op.id, text: op.message.text }];
  if (op.op === "thread.edit") return [{ kind: "edited", id: op.id, text: op.text }];
  if (op.op === "thread.update" && op.status)
    return [{ kind: "status", id: op.id, status: op.status }];
  return [];
}

/** Whether an op changes the design beyond its artboards: its pages, tokens or name. */
export function touchesStructure(op: Op): boolean {
  if (op.op === "batch") return op.ops.some(touchesStructure);
  return op.op.startsWith("page.") || op.op === "tokens" || op.op === "file.rename";
}

/** A few words on what an op did, read against the doc after it. */
export function summarize(doc: Doc, op: Op): string {
  if (op.op === "batch") {
    const parts = [...new Set(op.ops.map((o) => summarize(doc, o)))];
    return parts.length > 3 ? `${parts.slice(0, 3).join("; ")}; …` : parts.join("; ");
  }
  const name = (id: string) => {
    const ab = findArtboard(doc, id);
    if (ab) return `"${ab.artboard.name}"`;
    const hit = locate(doc, id);
    return hit?.node.name ? `"${hit.node.name}"` : id;
  };
  switch (op.op) {
    case "insert":
      return `added to ${name(op.parent)}`;
    case "remove":
      return `removed ${op.id}`;
    case "move":
      return `moved ${name(op.id)}`;
    case "style":
      return `restyled ${name(op.id)}`;
    case "attrs":
      return `changed attributes on ${name(op.id)}`;
    case "name":
      return `renamed ${op.id}`;
    case "children":
      return `rewrote ${name(op.id)}`;
    case "artboard.create":
      return `created artboard "${op.artboard.name}"`;
    case "artboard.delete":
      return `deleted artboard ${op.id}`;
    case "artboard.update":
      return `updated artboard ${name(op.id)}`;
    case "artboard.move":
      return `moved artboard ${name(op.id)} to another page`;
    case "page.create":
      return `created page "${op.page.name}"`;
    case "page.delete":
      return "deleted a page";
    case "page.update":
      return "updated a page";
    case "page.order":
      return "reordered pages";
    case "page.move":
      return "moved a page";
    case "tokens":
      return "changed tokens";
    case "file.rename":
      return `renamed the file to "${op.name}"`;
    case "file.icon":
      return "changed the file's icon";
    case "file.scratch":
      return op.scratch ? "marked the file as scratch" : "took the file out of scratch";
    case "note":
      return `${op.content === null ? "deleted" : "wrote"} note ${op.name}`;
    default:
      return op.op;
  }
}
