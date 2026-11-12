import type { Doc, PNode } from "@ponzu/core";
import { fromMarkdown } from "mdast-util-from-markdown";
// The thread's own reader of our address (#451): what the studio follows in place is what passes.
import { parseCanvasAddress } from "../../../studio/src/cloud/ui/canvas-address.ts";

export { parseCanvasAddress };

/*
 * What code decides exactly about a turn's messages: each check has one right answer, so a
 * failing one fails the case. Whether a link was put where it helps, or a message has the right
 * shape, is the thread judge's (judge.ts).
 *
 * Messages are read as the thread reads them: Markdown, parsed by the parser the studio's
 * react-markdown uses (mdast-util-from-markdown, CommonMark, no autolinks).
 */

/* ------------------------------------------------------------------ */
/* What a message holds                                                */
/* ------------------------------------------------------------------ */

export interface Link {
  text: string;
  href: string;
}

interface Parsed {
  links: Link[];
  /** Everything a person reads: the text, link text and code, never a link's address. */
  readable: string;
}

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

function parse(markdown: string): Parsed {
  const links: Link[] = [];
  const read: string[] = [];
  const walk = (node: MdNode): string => {
    if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
      read.push(node.value ?? "");
      return node.value ?? "";
    }
    const inner = (node.children ?? []).map(walk).join("");
    if (node.type === "link") links.push({ text: inner, href: node.url ?? "" });
    return inner;
  };
  walk(fromMarkdown(markdown) as MdNode);
  return { links, readable: read.join("\n") };
}

/** Every page, board and node id in a document. */
export function idsOf(doc: Doc): Set<string> {
  const ids = new Set<string>();
  const visit = (node: PNode) => {
    if (node.kind !== "el") return;
    ids.add(node.id);
    node.children.forEach(visit);
  };
  for (const page of doc.pages) {
    ids.add(page.id);
    for (const artboard of page.artboards) {
      ids.add(artboard.id);
      visit(artboard.root);
    }
  }
  return ids;
}

export interface MessageChecks {
  /** Each check, passed or not. */
  results: Record<string, boolean>;
  /** What failed, in words. */
  problems: string[];
  /** Every link to this canvas, for the metrics. */
  links: Link[];
}

/**
 * The exact checks on a turn's messages, against the document at the end of the turn (and, for
 * ids, at its start too, so an id the agent deleted still counts):
 * - links: every link to ponzu.design is our address, for this canvas, and its page or board is
 *   in the document at the end of the turn;
 * - no_bare_address: no canvas address is pasted as text rather than linked;
 * - no_ids: no page, board or node id appears in what a person reads.
 */
export function checkMessages(
  messages: readonly string[],
  { canvasId, docAfter, docBefore }: { canvasId: string; docAfter: Doc; docBefore: Doc },
): MessageChecks {
  const problems: string[] = [];
  const links: Link[] = [];
  const pages = new Set(docAfter.pages.map((p) => p.id));
  const boards = new Set(docAfter.pages.flatMap((p) => p.artboards.map((a) => a.id)));
  const ids = new Set([...idsOf(docAfter), ...idsOf(docBefore)]);
  let linksOk = true;
  let bareOk = true;
  let idsOk = true;
  for (const message of messages) {
    const parsed = parse(message);
    for (const link of parsed.links) {
      let host: string | null = null;
      try {
        host = new URL(link.href).hostname;
      } catch {}
      if (host !== "ponzu.design") continue;
      links.push(link);
      const at = parseCanvasAddress(link.href);
      if (!at) {
        linksOk = false;
        problems.push(`not our address: ${link.href}`);
      } else if (at.canvasId !== canvasId) {
        linksOk = false;
        problems.push(`another canvas's address: ${link.href}`);
      } else if (at.page && !pages.has(at.page)) {
        linksOk = false;
        problems.push(`a page not in the canvas: ${link.href}`);
      } else if (at.artboard && !boards.has(at.artboard)) {
        linksOk = false;
        problems.push(`a board not in the canvas: ${link.href}`);
      }
    }
    if (parsed.readable.includes("ponzu.design/canvases/")) {
      bareOk = false;
      problems.push("a canvas address pasted as text");
    }
    for (const id of ids) {
      if (parsed.readable.includes(id)) {
        idsOk = false;
        problems.push(`an id in the text: ${id}`);
      }
    }
  }
  return {
    results: { links: linksOk, no_bare_address: bareOk, no_ids: idsOk },
    problems,
    links,
  };
}

/**
 * When the turn made commits, `describe_pull_request` was called after the last one: the
 * instruction to describe the branch once it has the change is unconditional. Times are compared
 * in whole seconds, as git records them.
 */
export function describedAfterLastCommit(
  commits: readonly { at: number }[],
  summaries: readonly { at: number }[],
): boolean | null {
  if (!commits.length) return null;
  const last = Math.max(...commits.map((c) => c.at));
  return summaries.some((s) => Math.floor(s.at / 1000) >= last);
}

/** What a case says the turn should do to the pull request. */
export interface PullRequestExpected {
  /** It opens the pull request itself: its work is committed and worth a review. */
  opens?: boolean;
  /** It merges (or turns on auto-merge): true only when the person asked for that outcome. */
  merges: boolean;
}

/**
 * Whether the turn did to its pull request what the case expects: opened it when it should, and
 * merged only when asked. An attempt counts as much as a merge: a merge nobody asked for that the
 * API refused is still the agent trying. Null for a case that expects nothing of it.
 */
export function pullRequestAsAsked(
  calls: readonly { action: string; outcome: string }[],
  expected: PullRequestExpected | undefined,
): { opened: boolean | null; merged: boolean | null; problems: string[] } {
  if (!expected) return { opened: null, merged: null, problems: [] };
  const problems: string[] = [];
  const landing = calls.filter((c) => c.action === "merge" || c.action === "auto_merge");
  let opened: boolean | null = null;
  if (expected.opens !== undefined) {
    const did = calls.some((c) => c.action === "open" && c.outcome === "done");
    opened = did === expected.opens;
    if (!opened) {
      problems.push(
        did ? "opened a pull request it should not have" : "did not open the pull request",
      );
    }
  }
  // Told to merge, only a merge GitHub took passes: auto-merge has not landed anything yet.
  const merged = expected.merges
    ? calls.some((c) => c.action === "merge" && c.outcome === "done")
    : landing.length === 0;
  if (!merged) {
    problems.push(
      expected.merges
        ? "did not merge, though the person asked it to"
        : `tried to land it, though nobody asked: ${landing.map((c) => `${c.action} (${c.outcome})`).join(", ")}`,
    );
  }
  return { opened, merged, problems };
}
