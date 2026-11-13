import {
  findMatches,
  foldForSearch,
  type Match,
  type SearchTerm,
  searchTerms,
  snippet,
} from "@ponzu/core";
import {
  listWorkspacePeople,
  type PrState,
  SEARCH_GROUPS,
  type SearchGroup,
  type SearchHit,
  type SearchHits,
  searchCanvases,
  type User,
  type WorkspacePerson,
} from "@ponzu/db";
import { refreshWorkspaceRepoAccess } from "../auth/repo-access.ts";
import type { Deps } from "../deps/index.ts";
import type { Logger } from "../http/log.ts";

/*
 * A search of one workspace (docs/cloud.md "Search"), behind `POST /v1/workspaces/:id/search`:
 * the canvases, boards, comments, messages and pull requests the person may read, from
 * `searchCanvases`, and the people of the workspace GitHub would show them, matched here. The
 * route has checked that the person is a member.
 *
 * Nothing a person typed reaches a log line or an event: the `search` line and `search answered`
 * carry lengths, counts and times.
 */

/** Every group an answer has, in the order clients show them. */
export const ANSWER_GROUPS = [...SEARCH_GROUPS, "people"] as const;
export type AnswerGroup = (typeof ANSWER_GROUPS)[number];

/** The most people an answer holds. */
export const PEOPLE_CAP = 4;

/** The longest query, in characters after trimming. */
export const QUERY_MAX = 200;

/** Who wrote a comment or a message, as an answer names them. */
export type SearchAuthorView =
  | { kind: "user"; id: string; name: string; login: string; avatarUrl: string | null }
  | { kind: "agent" }
  | { kind: "deleted" };

export interface SearchAnswer {
  query: string;
  canvases: { canvasId: string; name: string; matches: Match[] }[];
  boards: {
    canvasId: string;
    canvasName: string;
    kind: "page" | "board";
    id: string;
    pageId: string | null;
    name: string;
    matches: Match[];
  }[];
  comments: {
    canvasId: string;
    canvasName: string;
    threadId: string;
    messageId: string;
    pageId: string | null;
    artboardId: string | null;
    resolved: boolean;
    snippet: string;
    matches: Match[];
    author: SearchAuthorView;
    at: Date | null;
  }[];
  messages: {
    canvasId: string;
    canvasName: string;
    itemId: string;
    itemSeq: number;
    snippet: string;
    matches: Match[];
    author: SearchAuthorView;
    at: Date | null;
  }[];
  pullRequests: {
    canvasId: string;
    canvasName: string;
    number: number;
    title: string;
    matches: Match[];
    state: PrState | null;
  }[];
  people: {
    userId: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
    nameMatches: Match[];
    loginMatches: Match[];
  }[];
}

/** An answer with nothing in it. */
export const emptyAnswer = (query: string): SearchAnswer => ({
  query,
  canvases: [],
  boards: [],
  comments: [],
  messages: [],
  pullRequests: [],
  people: [],
});

type SearchDeps = Pick<Deps, "db" | "clock" | "analytics" | "github" | "vault"> & { log: Logger };

/**
 * Answer `query` for `user` in `workspace`, in the `groups` asked for (every one when left out).
 * Repo access is brought up to the minute first, exactly as the canvas list does, so a repo
 * the person lost leaves search when it leaves the list; GitHub failing past the fallback is
 * `upstream_unavailable`, as there.
 */
export async function searchWorkspace(
  deps: SearchDeps,
  {
    user,
    workspace,
    query,
    groups = ANSWER_GROUPS,
  }: {
    user: User;
    workspace: Parameters<typeof refreshWorkspaceRepoAccess>[1]["workspace"];
    query: string;
    groups?: readonly AnswerGroup[];
  },
): Promise<SearchAnswer> {
  const started = deps.clock.now();
  const terms = searchTerms(query);
  const answer = emptyAnswer(query);
  let accessMs = 0;
  let queryMs = 0;
  if (terms.length > 0 && groups.length > 0) {
    await refreshWorkspaceRepoAccess(deps, { user, workspace });
    const accessed = deps.clock.now();
    accessMs = accessed - started;
    const asked = groups.filter((group): group is SearchGroup => group !== "people");
    const [hits, people] = await Promise.all([
      searchCanvases(deps.db, {
        workspaceId: workspace.id,
        userId: user.id,
        terms,
        groups: asked,
      }),
      groups.includes("people")
        ? listWorkspacePeople(deps.db, { workspaceId: workspace.id, viewerUserId: user.id })
        : Promise.resolve([]),
    ]);
    queryMs = deps.clock.now() - accessed;
    shape(answer, hits, terms);
    answer.people = matchPeople(people, terms);
  }
  const ms = deps.clock.now() - started;
  const counts = Object.fromEntries(ANSWER_GROUPS.map((group) => [group, answer[group].length]));
  const results = ANSWER_GROUPS.reduce((sum, group) => sum + answer[group].length, 0);
  // Never the words: their length, how many terms, and what came back.
  deps.log.info("search", {
    workspaceId: workspace.id,
    ms,
    access_ms: accessMs,
    query_ms: queryMs,
    terms: terms.length,
    q_len: query.length,
    ...counts,
  });
  deps.analytics.capture(
    "search answered",
    {
      q_length: query.length,
      terms: terms.length,
      results,
      groups: ANSWER_GROUPS.filter((group) => answer[group].length > 0),
      ms,
    },
    { workspaceId: workspace.id },
  );
  return answer;
}

/** The database's hits as the answer has them: matches, snippets, authors, pull request states. */
function shape(answer: SearchAnswer, hits: SearchHits, terms: readonly SearchTerm[]): void {
  for (const hit of hits.canvases) {
    answer.canvases.push({
      canvasId: hit.canvasId,
      name: hit.text,
      matches: findMatches(hit.text, terms),
    });
  }
  for (const hit of hits.boards) {
    if (hit.context.kind !== "page" && hit.context.kind !== "board") continue;
    answer.boards.push({
      canvasId: hit.canvasId,
      canvasName: hit.canvasName,
      kind: hit.context.kind,
      id: hit.ref,
      pageId: hit.context.kind === "board" ? hit.context.pageId : null,
      name: hit.text,
      matches: findMatches(hit.text, terms),
    });
  }
  for (const hit of hits.comments) {
    const { context } = hit;
    if (context.kind !== "comment") continue;
    const cut = snippet(hit.text, findMatches(hit.text, terms));
    answer.comments.push({
      canvasId: hit.canvasId,
      canvasName: hit.canvasName,
      threadId: context.threadId,
      messageId: context.messageId,
      pageId: context.pageId,
      artboardId: context.artboardId,
      resolved: context.resolved,
      snippet: cut.text,
      matches: [...cut.matches],
      author: authorOf(hit),
      at: hit.at,
    });
  }
  for (const hit of hits.messages) {
    const { context } = hit;
    if (context.kind !== "message") continue;
    const cut = snippet(hit.text, findMatches(hit.text, terms));
    answer.messages.push({
      canvasId: hit.canvasId,
      canvasName: hit.canvasName,
      itemId: hit.ref,
      itemSeq: context.itemSeq,
      snippet: cut.text,
      matches: [...cut.matches],
      author: authorOf(hit),
      at: hit.at,
    });
  }
  for (const hit of hits.pullRequests) {
    const { context } = hit;
    if (context.kind !== "pull_request") continue;
    const title = titleOf(hit.text, context.number);
    answer.pullRequests.push({
      canvasId: hit.canvasId,
      canvasName: hit.canvasName,
      number: context.number,
      title,
      matches: findMatches(title, terms),
      // The canvas row knows the state of its current pull request only.
      state: hit.canvasPr?.number === context.number ? hit.canvasPr.state : null,
    });
  }
}

/** A pull request entry's title: its text is `#<number> <title>`. */
function titleOf(text: string, number: number): string {
  const prefix = `#${number} `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * Who wrote a hit: a person whose account is there, by their row as it is now; a person whose
 * row is gone deleted their account, and is "Deleted user" whatever name the entry kept; else
 * the agent.
 */
function authorOf(hit: SearchHit): SearchAuthorView {
  if (hit.authorUser) {
    const { id, name, login, avatarUrl } = hit.authorUser;
    return { kind: "user", id, name: name ?? login, login, avatarUrl };
  }
  if (hit.authorKind === "agent") return { kind: "agent" };
  return { kind: "deleted" };
}

/**
 * The people who match: only those who have joined (a person who has not opened Ponzu has
 * nothing to filter by), each term found in their name or their login. Ranked as entries are
 * (whole, prefix, every term at a word start, anywhere), then admins, then by name, at most
 * PEOPLE_CAP. `people` is already only whom GitHub would show the searcher.
 */
export function matchPeople(
  people: readonly WorkspacePerson[],
  terms: readonly SearchTerm[],
): SearchAnswer["people"] {
  if (terms.length === 0) return [];
  const phrase = terms.map((term) => term.words.join(" ")).join(" ");
  const ranked: { person: SearchAnswer["people"][number]; tier: number; admin: boolean }[] = [];
  for (const person of people) {
    if (person.userId === null) continue;
    const name = person.name ?? "";
    const login = person.githubLogin;
    const every = terms.every(
      (term) => findMatches(name, [term]).length > 0 || findMatches(login, [term]).length > 0,
    );
    if (!every) continue;
    ranked.push({
      person: {
        userId: person.userId,
        login,
        name: person.name,
        avatarUrl: person.avatarUrl,
        nameMatches: findMatches(name, terms),
        loginMatches: findMatches(login, terms),
      },
      tier: Math.min(tierOf(name, phrase, terms), tierOf(login, phrase, terms)),
      admin: person.role === "admin",
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

/** How well `text` matches, as `searchCanvases` ranks an entry: 0 best, 4 not at all. */
function tierOf(text: string, phrase: string, terms: readonly SearchTerm[]): number {
  const folded = foldForSearch(text).trim();
  if (folded === "") return 4;
  if (folded === phrase) return 0;
  if (folded.startsWith(phrase)) return 1;
  const words = ` ${folded.replace(/ +/g, " ")}`;
  if (terms.every((term) => words.includes(` ${term.words.join(" ")}`))) return 2;
  return 3;
}
