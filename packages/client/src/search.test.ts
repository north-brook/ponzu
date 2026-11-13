import { describe, expect, test } from "bun:test";
import { type Doc, newOpId, type Thread } from "@ponzu/core";
import { el } from "@ponzu/core/fixtures";
import type { TurnRecord } from "@ponzu/runner/protocol";
import { keepPreviousData } from "@tanstack/react-query";
// The API's own words of an answer, which the fake's are held to; the package never imports it.
import { plainText as apiAnswerText } from "../../../apps/api/src/search/plain.ts";
import { type Api, createApi, SEARCH_GROUPS, type SearchAnswer, type SearchGroup } from "./api.ts";
import { systemClock } from "./clock.ts";
import { ApiError } from "./errors.ts";
import { createQueryClient } from "./query/client.ts";
import { queryKeys } from "./query/keys.ts";
import { ponzuQueries } from "./query/queries.ts";
import { createSession, SESSION_KEY } from "./session.ts";
import { createFakeBackend, type FakeBackend, type FakePerson } from "./testing/backend.ts";
import { FakeClock } from "./testing/clock.ts";
import { plainText as fakeAnswerText } from "./testing/search.ts";

/*
 * Search in the client: the request, its cache key and query options, and the fake backend's
 * search, which follows the route's rules so that screens built on it see what the API would
 * show. That the fake answers the route's exact shapes is proved against the real API in
 * api.test.ts.
 */

/* ------------------------------------------------------------------ */
/* The request                                                         */
/* ------------------------------------------------------------------ */

interface Held {
  url: string;
  body: unknown;
  /** Whether the request's own fetch was given up on through its signal. */
  aborted(): boolean;
  answer(status: number, json: unknown): void;
}

/** An `Api` whose requests wait until the test answers them, and give up when aborted. */
function heldApi(): { api: Api; held: Held[] } {
  const held: Held[] = [];
  const user = { id: "usr_1", githubLogin: "maya", name: null, email: null, avatarUrl: null };
  const saved = JSON.stringify({
    accessToken: "access",
    refreshToken: "refresh",
    user,
    refreshAt: Number.MAX_SAFE_INTEGER,
  });
  const session = createSession({
    apiUrl: "https://api.test",
    workosClientId: "client_test",
    storage: {
      get: async (key) => (key === SESSION_KEY ? saved : null),
      set: async () => {},
      delete: async () => {},
    },
    clock: systemClock,
    client: { platform: "macos", version: "2.0.0" },
    fetch: (input, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        held.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : null,
          aborted: () => signal?.aborted ?? false,
          answer: (status, json) =>
            resolve(
              new Response(JSON.stringify(json), {
                status,
                headers: { "content-type": "application/json" },
              }),
            ),
        });
      }),
  });
  return { api: createApi(session), held };
}

/** Until `held` has `n` requests; the session reads its storage before it sends. */
async function sent(held: Held[], n = 1): Promise<void> {
  for (let tries = 0; held.length < n; tries++) {
    if (tries > 1_000) throw new Error(`Only ${held.length} requests were sent.`);
    await Promise.resolve();
  }
}

const empty = (query: string): SearchAnswer => ({
  query,
  canvases: [],
  boards: [],
  comments: [],
  messages: [],
  pullRequests: [],
  people: [],
});

describe("the request", () => {
  test("is a POST to the workspace's search, with the words in its body", async () => {
    const { api, held } = heldApi();
    const answered = api.workspaces.search("ws_1", { q: "okapi", groups: ["canvases"] });
    await sent(held);
    expect(held[0]!.url).toBe("https://api.test/v1/workspaces/ws_1/search");
    expect(held[0]!.url).not.toContain("okapi");
    expect(held[0]!.body).toEqual({ q: "okapi", groups: ["canvases"] });
    held[0]!.answer(200, empty("okapi"));
    expect(await answered).toEqual(empty("okapi"));
  });

  test("given up on, it rejects with an AbortError, not an ApiError", async () => {
    const { api, held } = heldApi();
    const controller = new AbortController();
    const answered = api.workspaces
      .search("ws_1", { q: "okapi" }, { signal: controller.signal })
      .catch((error) => error);
    await sent(held);
    controller.abort();
    const error = await answered;
    expect(held[0]!.aborted()).toBe(true);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.name).toBe("AbortError");
  });

  test("given up on before it was sent, it is never sent", async () => {
    const { api, held } = heldApi();
    const controller = new AbortController();
    controller.abort();
    const error = await api.workspaces
      .search("ws_1", { q: "okapi" }, { signal: controller.signal })
      .catch((e) => e);
    expect(error.name).toBe("AbortError");
    expect(held).toEqual([]);
  });

  test("a refusal is the API's error, by code", async () => {
    const { api, held } = heldApi();
    const answered = api.workspaces.search("ws_1", { q: "x" }).catch((e) => e);
    await sent(held);
    held[0]!.answer(404, { error: { code: "not_found", message: "There is no such workspace." } });
    const error = await answered;
    expect(error).toBeInstanceOf(ApiError);
    expect([error.status, error.code]).toEqual([404, "not_found"]);
  });
});

/* ------------------------------------------------------------------ */
/* The query                                                           */
/* ------------------------------------------------------------------ */

describe("the query", () => {
  test("its key is the query trimmed and in NFC, so spacing and how an accent was typed ask once", () => {
    const composed = "café";
    const decomposed = "café";
    expect(queryKeys.search("ws_1", `  ${decomposed} `, ["canvases", "boards"])).toEqual([
      "ponzu",
      "search",
      "ws_1",
      composed,
      "canvases,boards",
    ]);
    const queries = ponzuQueries(heldApi().api);
    expect(queries.search("ws_1", ` ${decomposed}`).queryKey).toEqual(
      queries.search("ws_1", composed).queryKey,
    );
    // Every group by default, in the order clients show them.
    expect(queries.search("ws_1", "x").queryKey.at(-1)).toBe(SEARCH_GROUPS.join(","));
    // SEARCH_GROUPS lists every group the route takes: one added there fails to compile here.
    const everyGroupListed: [Exclude<SearchGroup, (typeof SEARCH_GROUPS)[number]>] extends [never]
      ? true
      : false = true;
    expect(everyGroupListed).toBe(true);
    // Other groups are another answer.
    expect(queries.search("ws_1", "x", ["canvases"]).queryKey).not.toEqual(
      queries.search("ws_1", "x").queryKey,
    );
  });

  test("its options: off for an empty query, half a minute fresh, two minutes kept, the last answer shown meanwhile", () => {
    const queries = ponzuQueries(heldApi().api);
    const options = queries.search("ws_1", "okapi");
    expect(options.enabled).toBe(true);
    expect(queries.search("ws_1", "   ").enabled).toBe(false);
    expect(options.staleTime).toBe(30_000);
    expect(options.gcTime).toBe(120_000);
    expect(options.placeholderData).toBe(keepPreviousData);
  });

  test("asked again once after no answer or a 5xx, never after a 4xx", () => {
    const retry = ponzuQueries(heldApi().api).search("ws_1", "okapi").retry as (
      failures: number,
      error: unknown,
    ) => boolean;
    const offline = new ApiError(0, "network", "Offline.");
    expect(retry(0, offline)).toBe(true);
    expect(retry(0, new ApiError(503, "database_unavailable", "Later."))).toBe(true);
    expect(retry(1, offline)).toBe(false);
    expect(retry(0, new ApiError(400, "invalid_request", "No."))).toBe(false);
    expect(retry(0, new ApiError(404, "not_found", "No."))).toBe(false);
    expect(retry(0, new ApiError(429, "rate_limited", "Slow down."))).toBe(false);
    expect(retry(0, new ApiError(408, "internal", "Too slow."))).toBe(false);
    const aborted = new Error("Aborted");
    aborted.name = "AbortError";
    expect(retry(0, aborted)).toBe(false);
  });

  test("sends the trimmed query with TanStack's signal; a cancelled ask is not cached, and asks again", async () => {
    const { api, held } = heldApi();
    const queryClient = createQueryClient();
    const options = ponzuQueries(api).search("ws_1", "  okapi ", ["canvases"]);

    const first = queryClient.fetchQuery(options).catch((error) => error);
    await sent(held);
    expect(held[0]!.body).toEqual({ q: "okapi", groups: ["canvases"] });
    await queryClient.cancelQueries({ queryKey: options.queryKey });
    await first;
    // The request itself was given up on, not only its answer dropped.
    expect(held[0]!.aborted()).toBe(true);
    expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();

    const second = queryClient.fetchQuery(options);
    await sent(held, 2);
    held[1]!.answer(200, empty("okapi"));
    expect(await second).toEqual(empty("okapi"));
    expect(queryClient.getQueryData(options.queryKey)).toEqual(empty("okapi"));
  });
});

/* ------------------------------------------------------------------ */
/* The fake backend's search                                           */
/* ------------------------------------------------------------------ */

interface World {
  backend: FakeBackend;
  maya: FakePerson;
  ines: FakePerson;
  omar: FakePerson;
  ws: { id: string; repos: { id: string }[] };
  as: (person: FakePerson) => Api;
}

/** An org with a repo Maya and Ines can push to and Omar cannot read, and one Ines may only read. */
function world(clock?: FakeClock): World {
  const backend = createFakeBackend(clock ? { clock } : {});
  const maya = backend.addPerson({ login: "maya", name: "Maya Ortiz" });
  const ines = backend.addPerson({ login: "ines", name: "Inés Park" });
  const omar = backend.addPerson({ login: "omar", name: "Omar Haddad" });
  const ws = backend.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin", [ines.id]: "member", [omar.id]: "member" },
    repos: [
      { name: "web", access: { [omar.id]: "none" } },
      { name: "docs", access: { [ines.id]: "read", [omar.id]: "none" } },
    ],
    githubOnly: [{ login: "maya-bot", name: "Maya Bot" }],
  });
  return { backend, maya, ines, omar, ws, as: (person) => backend.connect(person).api };
}

const comment = (id: string, text: string, artboardId: string): Thread => ({
  id,
  artboardId,
  x: 1,
  y: 2,
  status: "open",
  createdAt: 0,
  updatedAt: 0,
  messages: [{ id: `${id}_m`, author: { kind: "user", name: "" }, text, createdAt: 0 }],
});

/**
 * A canvas named `name`, made by whoever `api` is, with a page, a board and a comment that
 * carry `word`. The agent draws the board, as only it may.
 */
async function canvasWith(
  backend: FakeBackend,
  api: Api,
  workspaceId: string,
  repoId: string | null,
  name: string,
  word: string,
): Promise<{ id: string; pageId: string }> {
  const created = await api.canvases.create({
    workspaceId,
    ...(repoId ? { repoId } : {}),
    name,
  });
  const { doc } = await api.canvases.doc(created.id);
  const pageId = (doc as Doc).pages[0]!.id;
  const board = `ab_${created.id.slice(-8)}`;
  backend.agent(created.id).commit([
    {
      op: "artboard.create",
      page: pageId,
      index: 0,
      artboard: { id: board, name: `${word} board`, x: 0, y: 0, root: el(board, "section") },
    },
  ]);
  const { rejected } = await api.canvases.commit(created.id, [
    { id: newOpId(), op: { op: "page.update", id: pageId, name: `${word} page` } },
    {
      id: newOpId(),
      op: {
        op: "thread.create",
        thread: comment(`th_${created.id.slice(-8)}`, `is the ${word} right?`, board),
      },
    },
  ]);
  expect(rejected).toEqual([]);
  return { id: created.id, pageId };
}

/** Each group's canvas ids. */
const ids = (answer: SearchAnswer) =>
  Object.fromEntries(
    SEARCH_GROUPS.filter((group) => group !== "people").map((group) => [
      group,
      [...new Set(answer[group].map((hit) => hit.canvasId))].sort(),
    ]),
  );

describe("the fake backend's search", () => {
  test("finds names, pages, boards, comments and messages, with matches into what it shows", async () => {
    const { backend, maya, ws, as } = world();
    const api = as(maya);
    const canvas = await canvasWith(backend, api, ws.id, ws.repos[0]!.id, "Okapi launch", "okapi");
    const said = await api.canvases.sendMessage(canvas.id, { text: "Draw the okapi pricing" });

    const answer = await api.workspaces.search(ws.id, { q: " okapi " });

    expect(answer.query).toBe("okapi");
    expect(answer.canvases).toEqual([
      { canvasId: canvas.id, name: "Okapi launch", matches: [[0, 5]] },
    ]);
    expect(answer.boards.map((hit) => [hit.kind, hit.name, hit.pageId])).toEqual([
      ["board", "okapi board", canvas.pageId],
      ["page", "okapi page", null],
    ]);
    expect(answer.comments).toEqual([
      expect.objectContaining({
        canvasId: canvas.id,
        canvasName: "Okapi launch",
        snippet: "is the okapi right?",
        matches: [[7, 12]],
        resolved: false,
        pageId: canvas.pageId,
        author: { kind: "user", id: maya.id, name: "Maya Ortiz", login: "maya", avatarUrl: null },
      }),
    ]);
    expect(answer.messages).toEqual([
      {
        canvasId: canvas.id,
        canvasName: "Okapi launch",
        itemId: said.id,
        itemSeq: said.seq,
        snippet: "Draw the okapi pricing",
        matches: [[9, 14]],
        author: { kind: "user", id: maya.id, name: "Maya Ortiz", login: "maya", avatarUrl: null },
        at: said.at,
      },
    ]);
    expect(backend.canvases.size).toBe(1);
  });

  test("only the canvases the list shows: no one else's Scratch, no repo answered none", async () => {
    const { backend, maya, ines, omar, ws, as } = world();
    const [web, docs] = ws.repos as [{ id: string }, { id: string }];
    const inWeb = await canvasWith(backend, as(maya), ws.id, web.id, "Gecko web", "gecko");
    const inDocs = await canvasWith(backend, as(maya), ws.id, docs.id, "Gecko docs", "gecko");
    const mayas = await canvasWith(backend, as(maya), ws.id, null, "Gecko scratch", "gecko");
    const omars = await canvasWith(backend, as(omar), ws.id, null, "Gecko omar", "gecko");

    const search = async (person: FakePerson) =>
      ids(await as(person).workspaces.search(ws.id, { q: "gecko" }));
    const listed = async (person: FakePerson) =>
      (await as(person).workspaces.canvases(ws.id)).canvases.map((c) => c.id).sort();

    const everyGroup = (canvasIds: string[]) => ({
      canvases: canvasIds,
      boards: canvasIds,
      comments: canvasIds,
      messages: [],
      pullRequests: [],
    });
    expect(await search(maya)).toEqual(everyGroup([inWeb.id, inDocs.id, mayas.id].sort()));
    expect(await search(ines)).toEqual(everyGroup([inWeb.id, inDocs.id].sort()));
    expect(await search(omar)).toEqual(everyGroup([omars.id]));
    // Never a canvas the list would not show.
    for (const person of [maya, ines, omar]) {
      const shown = await listed(person);
      for (const found of Object.values(await search(person))) {
        expect(found.every((id) => shown.includes(id))).toBe(true);
      }
    }
  });

  test("a workspace the person left is not found, as one that does not exist", async () => {
    const { backend, maya, ines, ws, as } = world();
    await canvasWith(backend, as(maya), ws.id, ws.repos[0]!.id, "Serval", "serval");
    backend.workspaces.get(ws.id)!.members.delete(ines.id);

    const theirs = await as(ines)
      .workspaces.search(ws.id, { q: "serval" })
      .catch((e) => e);
    const nowhere = await as(ines)
      .workspaces.search("ws_nothing", { q: "serval" })
      .catch((e) => e);

    expect([theirs.status, theirs.code, theirs.message]).toEqual([
      nowhere.status,
      nowhere.code,
      nowhere.message,
    ]);
    expect(theirs.status).toBe(404);
  });

  test("the agent's answer of an ended turn, never an aside or a running turn's words", async () => {
    const { backend, maya, ws, as } = world();
    const api = as(maya);
    const canvas = await canvasWith(backend, api, ws.id, ws.repos[0]!.id, "Chat", "chat");
    const agent = backend.agent(canvas.id);
    const turn = (ended: TurnRecord["ended"], final: string | null): TurnRecord => ({
      ended,
      ms: 10,
      final,
      boards: 0,
      files: 0,
      log: [],
    });
    const work = agent.tool("Working", { turn: turn(null, null) });
    agent.say("Thinking about the narwhal aside");
    const answer = agent.say(
      "## Done\n\n- The **narwhal** tier\n- [Pricing](https://x.test/narwhal)",
    );
    agent.tool("Worked", { id: work, streaming: false, turn: turn("done", answer) });
    agent.tool("Working", { turn: turn(null, null) });
    agent.say("A narwhal draft");

    const found = await api.workspaces.search(ws.id, { q: "narwhal" });

    expect(found.messages.map((hit) => [hit.itemId, hit.snippet, hit.author])).toEqual([
      [answer, "Done The narwhal tier Pricing", { kind: "agent" }],
    ]);
    expect((await api.workspaces.search(ws.id, { q: "x.test" })).messages).toEqual([]);
  });

  test("a pull request by its title or number, with its state", async () => {
    const { backend, maya, ws, as } = world();
    const api = as(maya);
    const canvas = await canvasWith(backend, api, ws.id, ws.repos[0]!.id, "Ibex pricing", "ibex");
    backend.agent(canvas.id).push();
    const opened = await api.canvases.pullRequest.open(canvas.id);
    const number = opened.pullRequest!.number;

    const byTitle = (await api.workspaces.search(ws.id, { q: "ibex" })).pullRequests;
    const byNumber = (await api.workspaces.search(ws.id, { q: `#${number}` })).pullRequests;

    expect(byTitle).toEqual([
      {
        canvasId: canvas.id,
        canvasName: "Ibex pricing",
        number,
        title: "Ibex pricing",
        matches: [[0, 4]],
        state: "draft",
      },
    ]);
    expect(byNumber.map((hit) => [hit.number, hit.matches])).toEqual([[number, []]]);
  });

  test("people who have joined, by name or login, admins first", async () => {
    const { maya, ines, ws, as } = world();

    const answer = await as(ines).workspaces.search(ws.id, { q: "ma" });

    // Maya Bot has not opened Ponzu; Omar Haddad has no word starting "ma".
    expect(answer.people).toEqual([
      {
        userId: maya.id,
        login: "maya",
        name: "Maya Ortiz",
        avatarUrl: null,
        nameMatches: [[0, 2]],
        loginMatches: [[0, 2]],
      },
    ]);
    expect(
      (await as(maya).workspaces.search(ws.id, { q: "par" })).people.map((p) => p.login),
    ).toEqual(["ines"]);
  });

  test("a short word only at a word's start, and long text only once some word is long", async () => {
    const { backend, maya, ws, as } = world();
    const api = as(maya);
    const canvas = await canvasWith(backend, api, ws.id, ws.repos[0]!.id, "Kettle", "kettle");
    await api.canvases.sendMessage(canvas.id, { text: "the kettle is xl" });

    const short = await api.workspaces.search(ws.id, { q: "ke" });
    const inside = await api.workspaces.search(ws.id, { q: "tt" });
    const long = await api.workspaces.search(ws.id, { q: "ettl" });

    expect(short.canvases.map((hit) => hit.name)).toEqual(["Kettle"]);
    // Two letters search names alone, even where a comment or a message has them.
    expect([short.comments, short.messages]).toEqual([[], []]);
    expect(inside.canvases).toEqual([]);
    expect(long.canvases.map((hit) => hit.name)).toEqual(["Kettle"]);
    expect(long.messages).toHaveLength(1);
  });

  test("at most 8 of a group, best first, then the newest", async () => {
    const clock = new FakeClock();
    const { backend, maya, ws, as } = world(clock);
    const api = as(maya);
    // The whole name is made first, so it is the oldest: it leads only by how well it matches.
    await api.canvases.create({ workspaceId: ws.id, name: "Tapir" });
    for (let i = 0; i < 10; i++) {
      await clock.advance(1_000);
      await api.canvases.create({ workspaceId: ws.id, name: `Tapir ${i}` });
    }
    expect(backend.canvases.size).toBe(11);

    const answer = await api.workspaces.search(ws.id, { q: "tapir" });

    // The whole name first, then those that start with it, newest first.
    expect(answer.canvases.map((hit) => hit.name)).toEqual([
      "Tapir",
      "Tapir 9",
      "Tapir 8",
      "Tapir 7",
      "Tapir 6",
      "Tapir 5",
      "Tapir 4",
      "Tapir 3",
    ]);
  });

  test("a comment by someone who has since deleted their account names no one", async () => {
    const { backend, maya, ines, ws, as } = world();
    const canvas = await canvasWith(backend, as(ines), ws.id, ws.repos[0]!.id, "Quokka", "quokka");
    await as(ines).account.delete("ines");

    const answer = await as(maya).workspaces.search(ws.id, { q: "quokka" });

    expect(answer.comments.map((hit) => [hit.canvasId, hit.author])).toEqual([
      [canvas.id, { kind: "deleted" }],
    ]);
  });

  test("people who match as well: admins first, then by name", async () => {
    const backend = createFakeBackend();
    const al = backend.addPerson({ login: "al", name: "Al Reed" });
    const zoe = backend.addPerson({ login: "zoe", name: "Zoe Reed" });
    const ws = backend.addWorkspace({
      login: "acme",
      members: { [al.id]: "member", [zoe.id]: "admin" },
      repos: [{ name: "web" }],
    });

    const answer = await backend.connect(al).api.workspaces.search(ws.id, { q: "reed" });

    expect(answer.people.map((person) => person.login)).toEqual(["zoe", "al"]);
  });

  test("refuses what the route refuses, and answers punctuation with nothing", async () => {
    const { backend, maya, ws, as } = world();
    const api = as(maya);
    const stranger = backend.addPerson({ login: "stranger" });
    const refused = (body: { q: string; groups?: string[] }, person = maya) =>
      as(person)
        .workspaces.search(ws.id, body as never)
        .then(
          () => null,
          (error) => [error.status, error.code],
        );

    expect(await refused({ q: "   " })).toEqual([400, "invalid_request"]);
    expect(await refused({ q: "x".repeat(201) })).toEqual([400, "invalid_request"]);
    expect(await refused({ q: "okapi", groups: ["files"] })).toEqual([400, "invalid_request"]);
    expect(await refused({ q: ` ${"x".repeat(200)} ` })).toBeNull();
    // A member's bad request and a non-member's are the same 400; a good one is the non-member's 404.
    expect(await refused({ q: "   " }, stranger)).toEqual([400, "invalid_request"]);
    expect(await refused({ q: "okapi" }, stranger)).toEqual([404, "not_found"]);
    expect(await api.workspaces.search(ws.id, { q: "%_\\!" })).toEqual(empty("%_\\!"));
  });

  test("punctuation is never a wildcard: '100%' is '100', 'a_b' does not find 'axb'", async () => {
    const { maya, ws, as } = world();
    const api = as(maya);
    for (const name of ["Plan 1000", "axb notes", "1x0 grid"]) {
      await api.canvases.create({ workspaceId: ws.id, name });
    }
    const names = async (q: string) =>
      (await api.workspaces.search(ws.id, { q })).canvases.map((hit) => hit.name);

    expect(await names("100%")).toEqual(await names("100"));
    expect(await names("a_b")).toEqual([]);
    expect(await names("1%0")).toEqual([]);
  });

  test("gives up when told to, with an AbortError", async () => {
    const { maya, ws, as } = world();
    const controller = new AbortController();
    controller.abort();
    const error = await as(maya)
      .workspaces.search(ws.id, { q: "okapi" }, { signal: controller.signal })
      .catch((e) => e);
    expect(error.name).toBe("AbortError");
  });
});

test("the fake keeps the words of an agent's answer that the API keeps", () => {
  const answers = [
    "# Pricing\n\nThe **card** has [a link](https://example.test/target) and `code`.",
    "- one\n- two\n\n> quoted\n\n![alt words](https://example.test/picture.png)",
    "See [Pricing][price] and [Plans][].\n\n[price]: https://example.test/hiddenword\n[plans]: <https://example.test/other>",
    "one\n\n---\n\ntwo\n\n***",
    "Run it:\n\n~~~ts\nconst okapi = 1;\n~~~",
  ];
  for (const markdown of answers) expect(fakeAnswerText(markdown)).toBe(apiAnswerText(markdown));
  // A reference's definition is never searched, in either.
  expect(apiAnswerText(answers[2]!)).not.toContain("hiddenword");
});
