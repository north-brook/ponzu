import type { Doc, PNode } from "@ponzu/core";
import { fromMarkdown } from "mdast-util-from-markdown";

/*
 * What code decides exactly about a turn's messages: each check has one right answer, so a
 * failing one fails the case. Whether a link was put where it helps, or a message has the right
 * shape, is the thread judge's (judge.ts).
 *
 * Messages are read as the thread reads them: Markdown, parsed by the parser the studio's
 * react-markdown uses (mdast-util-from-markdown, CommonMark, no autolinks).
 */

/* ------------------------------------------------------------------ */
/* The design's own address                                            */
/* ------------------------------------------------------------------ */

/*
 * A copy of apps/studio/src/cloud/ui/design-address.ts from #451 (cloud-thread-links), which
 * has not merged: once it does, import that and delete this.
 *
 *   https://ponzu.design/designs/<design id>                  the design
 *   https://ponzu.design/designs/<design id>?page=<page id>   one of its pages
 *   https://ponzu.design/designs/<design id>?artboard=<id>    one of its boards
 */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PATH = /^\/designs\/([A-Za-z0-9_-]{1,64})\/?$/;

export interface DesignAddress {
  designId: string;
  page?: string;
  artboard?: string;
}

export function parseDesignAddress(href: string): DesignAddress | null {
  if (!URL.canParse(href)) return null;
  const url = new URL(href);
  if (url.protocol !== "https:" || url.hostname !== "ponzu.design") return null;
  if (url.port || url.username || url.password) return null;
  const designId = PATH.exec(url.pathname)?.[1];
  if (!designId) return null;
  const at: DesignAddress = { designId };
  for (const name of ["page", "artboard"] as const) {
    const values = url.searchParams.getAll(name);
    if (!values.length) continue;
    if (values.length > 1 || !ID.test(values[0]!)) return null;
    at[name] = values[0]!;
  }
  return at;
}

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
  /** Every link to this design, for the metrics. */
  links: Link[];
}

/**
 * The exact checks on a turn's messages, against the document at the end of the turn (and, for
 * ids, at its start too, so an id the agent deleted still counts):
 * - links: every link to ponzu.design is our address, for this design, and its page or board is
 *   in the document at the end of the turn;
 * - no_bare_address: no design address is pasted as text rather than linked;
 * - no_ids: no page, board or node id appears in what a person reads.
 */
export function checkMessages(
  messages: readonly string[],
  { designId, docAfter, docBefore }: { designId: string; docAfter: Doc; docBefore: Doc },
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
      const at = parseDesignAddress(link.href);
      if (!at) {
        linksOk = false;
        problems.push(`not our address: ${link.href}`);
      } else if (at.designId !== designId) {
        linksOk = false;
        problems.push(`another design's address: ${link.href}`);
      } else if (at.page && !pages.has(at.page)) {
        linksOk = false;
        problems.push(`a page not in the design: ${link.href}`);
      } else if (at.artboard && !boards.has(at.artboard)) {
        linksOk = false;
        problems.push(`a board not in the design: ${link.href}`);
      }
    }
    if (parsed.readable.includes("ponzu.design/designs/")) {
      bareOk = false;
      problems.push("a design address pasted as text");
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
