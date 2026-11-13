import {
  type Doc,
  docSearchEntries,
  findMatches,
  foldForSearch,
  type Match,
  SEARCH_SHORT_TERM,
  type SearchEntry,
  type SearchTerm,
  searchTerms,
  searchText,
  snippet,
} from "@ponzu/core";
import type { ThreadItem, TurnRecord } from "@ponzu/runner/protocol";
import type { SearchAnswer, SearchGroup } from "../api.ts";

/*
 * Search, as the fake backend answers it: the same rules as the API's route and the database's
 * statement (apps/api/src/search/search.ts, packages/db/src/queries/search.ts), run over the
 * fake's documents, threads and pull requests in memory through core's text rules. Which
 * canvases may be searched is the caller's to say, by the same rule as its canvas list.
 */

/** One canvas the person may read, as search needs it. */
export interface SearchableCanvas {
  id: string;
  /** Its name as its row has it. */
  name: string;
  doc: Doc;
  /** In milliseconds: what ranks entries that have no time of their own. */
  lastActivityAt: number;
  thread: readonly ThreadItem[];
  /** Its pull request, which the fake keeps one of. */
  pull: { number: number; title: string; state: SearchPrState } | null;
}

type SearchPrState = NonNullable<SearchAnswer["pullRequests"][number]["state"]>;

/** Someone in the workspace whom the person may see, joined or not. */
export interface SearchablePerson {
  /** Null for someone who has not opened Ponzu: never a hit. */
  userId: string | null;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  admin: boolean;
}

/** A person with an account now, by id; undefined for one who deleted it. */
type Account = (
  userId: string,
) => { name: string | null; login: string; avatarUrl: string | null } | undefined;

/** The groups the database answers, and the kinds each holds. */
const KINDS = {
  canvases: ["canvas"],
  boards: ["page", "board"],
  comments: ["comment"],
  messages: ["message"],
  pullRequests: ["pull_request"],
} as const;
type EntryGroup = keyof typeof KINDS;
const CAPS: Record<EntryGroup, number> = {
  canvases: 8,
  boards: 8,
  comments: 8,
  messages: 8,
  pullRequests: 4,
};
const PEOPLE_CAP = 4;
/** Searched only when some word of the query has SEARCH_SHORT_TERM characters or more. */
const LONG_TEXT: readonly EntryGroup[] = ["comments", "messages"];

interface Ranked {
  entry: SearchEntry;
  canvas: SearchableCanvas;
  tier: number;
  rankedAt: number;
}

/**
 * The answer to `query` over `canvases` and `people`, in `groups`. `query` has been checked (1
 * to 200 characters once trimmed) and comes trimmed, as the route has it.
 */
export function fakeSearch({
  query,
  groups,
  canvases,
  people,
  account,
}: {
  query: string;
  groups: readonly SearchGroup[];
  canvases: readonly SearchableCanvas[];
  people: readonly SearchablePerson[];
  account: Account;
}): SearchAnswer {
  const answer: SearchAnswer = {
    query,
    canvases: [],
    boards: [],
    comments: [],
    messages: [],
    pullRequests: [],
    people: [],
  };
  const terms = searchTerms(query);
  if (terms.length === 0) return answer;
  const longWord = terms.some((term) =>
    term.words.some((word) => [...word].length >= SEARCH_SHORT_TERM),
  );
  const searched = (Object.keys(KINDS) as EntryGroup[]).filter(
    (group) => groups.includes(group) && (longWord || !LONG_TEXT.includes(group)),
  );

  const hits = new Map<EntryGroup, Ranked[]>(searched.map((group) => [group, []]));
  for (const canvas of canvases) {
    for (const entry of entriesOf(canvas)) {
      const group = searched.find((g) => (KINDS[g] as readonly string[]).includes(entry.kind));
      if (!group || !terms.every((term) => findMatches(entry.text, [term]).length > 0)) continue;
      hits.get(group)!.push({
        entry,
        canvas,
        tier: tierOf(entry, terms),
        rankedAt: entry.at ?? canvas.lastActivityAt,
      });
    }
  }
  const order = (a: Ranked, b: Ranked) =>
    a.tier - b.tier ||
    b.rankedAt - a.rankedAt ||
    byCode(a.canvas.id, b.canvas.id) ||
    byCode(a.entry.kind, b.entry.kind) ||
    byCode(a.entry.ref, b.entry.ref);
  const kept = (group: EntryGroup) =>
    (hits.get(group) ?? []).slice().sort(order).slice(0, CAPS[group]);

  for (const { entry, canvas } of kept("canvases")) {
    answer.canvases.push({
      canvasId: canvas.id,
      name: entry.text,
      matches: findMatches(entry.text, terms).map(pair),
    });
  }
  for (const { entry, canvas } of kept("boards")) {
    const { context } = entry;
    if (context.kind !== "page" && context.kind !== "board") continue;
    answer.boards.push({
      canvasId: canvas.id,
      canvasName: canvas.name,
      kind: context.kind,
      id: entry.ref,
      pageId: context.kind === "board" ? context.pageId : null,
      name: entry.text,
      matches: findMatches(entry.text, terms).map(pair),
    });
  }
  for (const { entry, canvas } of kept("comments")) {
    const { context } = entry;
    if (context.kind !== "comment") continue;
    const cut = snippet(entry.text, findMatches(entry.text, terms));
    answer.comments.push({
      canvasId: canvas.id,
      canvasName: canvas.name,
      threadId: context.threadId,
      messageId: context.messageId,
      pageId: context.pageId,
      artboardId: context.artboardId,
      resolved: context.resolved,
      snippet: cut.text,
      matches: cut.matches.map(pair),
      author: authorOf(entry, account),
      at: entry.at === null ? null : new Date(entry.at).toISOString(),
    });
  }
  for (const { entry, canvas } of kept("messages")) {
    const { context } = entry;
    if (context.kind !== "message") continue;
    const cut = snippet(entry.text, findMatches(entry.text, terms));
    answer.messages.push({
      canvasId: canvas.id,
      canvasName: canvas.name,
      itemId: entry.ref,
      itemSeq: context.itemSeq,
      snippet: cut.text,
      matches: cut.matches.map(pair),
      author: authorOf(entry, account),
      at: entry.at === null ? null : new Date(entry.at).toISOString(),
    });
  }
  for (const { entry, canvas } of kept("pullRequests")) {
    const { context } = entry;
    if (context.kind !== "pull_request") continue;
    const prefix = `#${context.number} `;
    const title = entry.text.startsWith(prefix) ? entry.text.slice(prefix.length) : entry.text;
    answer.pullRequests.push({
      canvasId: canvas.id,
      canvasName: canvas.name,
      number: context.number,
      title,
      matches: findMatches(title, terms).map(pair),
      // The fake keeps one pull request a canvas, which is always its current one.
      state: canvas.pull?.number === context.number ? canvas.pull.state : null,
    });
  }
  if (groups.includes("people")) answer.people = matchPeople(people, terms);
  return answer;
}

/** The entries a canvas holds: its document's, its thread's, and its pull request's. */
function entriesOf(canvas: SearchableCanvas): SearchEntry[] {
  const entries = docSearchEntries(canvas.doc);
  entries.push(...threadEntries(canvas.thread));
  if (canvas.pull) {
    const { number, title } = canvas.pull;
    const text = searchText(`#${number} ${title}`);
    entries.push({
      kind: "pull_request",
      ref: String(number),
      text,
      context: { kind: "pull_request", number },
      author: null,
      at: null,
    });
  }
  return entries;
}

/**
 * The thread's entries, by the API's rule (apps/api/src/search/index-thread.ts): each person's
 * message, and each ended turn's `final` answer, or a finished answer from before turns kept a
 * record. Asides, answers of a running turn, tool steps, notices and comment copies never.
 */
function threadEntries(thread: readonly ThreadItem[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  let turn: TurnRecord | null = null;
  for (const item of thread.slice().sort((a, b) => a.seq - b.seq)) {
    const at = Date.parse(item.at);
    if (item.kind === "tool") {
      if (item.payload.turn) turn = item.payload.turn;
    } else if (item.kind === "message") {
      const text = searchText(item.payload.text);
      if (text.trim() === "") continue;
      const { from } = item.payload;
      out.push({
        kind: "message",
        ref: item.id,
        text,
        context: { kind: "message", itemSeq: item.seq },
        author: { kind: "user", id: from.id, name: from.name },
        at,
      });
    } else if (item.kind === "assistant" && !item.streaming) {
      const answers = turn === null || (turn.ended !== null && turn.final === item.id);
      const text = searchText(plainText(item.payload.text));
      if (!answers || text.trim() === "") continue;
      out.push({
        kind: "message",
        ref: item.id,
        text,
        context: { kind: "message", itemSeq: item.seq },
        author: { kind: "agent", id: "claude", name: "Claude" },
        at,
      });
    }
  }
  return out;
}

/**
 * Markdown's words, as the API keeps them (apps/api/src/search/plain.ts, which parses the
 * markdown properly), for the markdown an agent's answer holds: each line with words; heading,
 * quote and list marks, emphasis and code ticks dropped; an inline or reference link or image
 * kept as its text; and what a reader never sees as words left out (a reference's definition, a
 * rule, a code fence's own lines). The fake can't use the API's parser: it is an ES module the
 * phone's Jest can't load from here. Tables and HTML are not handled. Exported for the test that
 * holds it to the API's.
 */
export function plainText(markdown: string): string {
  return markdown
    .split("\n")
    .filter(
      (line) =>
        !/^ {0,3}\[[^\]]+\]:\s*\S/.test(line) &&
        !/^ {0,3}(?:[-*_] *){3,}$/.test(line) &&
        !/^ {0,3}(?:```|~~~)/.test(line),
    )
    .map((line) =>
      line
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
        .replace(/(\*\*|__|\*|_|`)/g, ""),
    )
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/** How well an entry matches, as the database ranks it: 0 best, 3 anywhere. */
function tierOf(entry: SearchEntry, terms: readonly SearchTerm[]): number {
  const folded = foldForSearch(entry.text);
  const words = terms.flatMap((term) => term.words).join(" +");
  if (new RegExp(`^ *${words} *$`, "u").test(folded)) return 0;
  if (entry.kind === "pull_request") {
    const numbers = terms
      .filter((term) => term.words.length === 1 && /^[0-9]{1,15}$/.test(term.words[0]!))
      .map((term) => String(Number(term.words[0])));
    if (numbers.includes(entry.ref)) return 0;
  }
  if (new RegExp(`^ *${words}`, "u").test(folded)) return 1;
  if (terms.every((term) => startsWord(folded, term))) return 2;
  return 3;
}

function startsWord(folded: string, term: SearchTerm): boolean {
  if (term.words.length > 1) return new RegExp(`(^| )${term.words.join(" +")}`, "u").test(folded);
  const word = term.words[0]!;
  return folded.startsWith(word) || folded.includes(` ${word}`);
}

/** Who wrote a hit, as the route says it: a person with an account, the agent, or deleted. */
function authorOf(
  entry: SearchEntry,
  account: Account,
): SearchAnswer["comments"][number]["author"] {
  const author = entry.author;
  if (author?.kind === "agent") return { kind: "agent" };
  const user = author?.id ? account(author.id) : undefined;
  if (!author?.id || !user) return { kind: "deleted" };
  return {
    kind: "user",
    id: author.id,
    name: user.name ?? user.login,
    login: user.login,
    avatarUrl: user.avatarUrl,
  };
}

/**
 * The people who match, as the route's `matchPeople` has them: joined people only, every term
 * in their name or login, ranked by tier, then admins, then by name, at most four.
 */
function matchPeople(
  people: readonly SearchablePerson[],
  terms: readonly SearchTerm[],
): SearchAnswer["people"] {
  const phrase = terms.map((term) => term.words.join(" ")).join(" ");
  const ranked: { person: SearchAnswer["people"][number]; tier: number; admin: boolean }[] = [];
  for (const person of people) {
    if (person.userId === null) continue;
    const name = person.name ?? "";
    const { login } = person;
    const found = (text: string, term: SearchTerm) => findMatches(text, [term]).length > 0;
    if (!terms.every((term) => found(name, term) || found(login, term))) continue;
    ranked.push({
      person: {
        userId: person.userId,
        login,
        name: person.name,
        avatarUrl: person.avatarUrl,
        nameMatches: findMatches(name, terms).map(pair),
        loginMatches: findMatches(login, terms).map(pair),
      },
      tier: Math.min(personTier(name, phrase, terms), personTier(login, phrase, terms)),
      admin: person.admin,
    });
  }
  return ranked
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        Number(b.admin) - Number(a.admin) ||
        (a.person.name ?? a.person.login).localeCompare(b.person.name ?? b.person.login),
    )
    .slice(0, PEOPLE_CAP)
    .map(({ person }) => person);
}

function personTier(text: string, phrase: string, terms: readonly SearchTerm[]): number {
  const folded = foldForSearch(text).trim();
  if (folded === "") return 4;
  if (folded === phrase) return 0;
  if (folded.startsWith(phrase)) return 1;
  const words = ` ${folded.replace(/ +/g, " ")}`;
  if (terms.every((term) => words.includes(` ${term.words.join(" ")}`))) return 2;
  return 3;
}

/** A match as JSON carries it: a plain pair. */
function pair(match: Match): [number, number] {
  return [match[0], match[1]];
}

/** Code-unit order, as the database's `collate "C"` sorts ids. */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
