import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Doc, emptyDoc, type Thread } from "@ponzu/core";
import { el } from "@ponzu/core/fixtures";
import {
  getCanvasAssetKey,
  listSearchEntries,
  listWorkspacePeople,
  newId,
  recordPullRequestRead,
} from "@ponzu/db";
import {
  type Access,
  call,
  canvasIn,
  canvasWithRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
import {
  createTestApp,
  type FakeInstallation,
  type SignedInPerson,
  type TestApp,
} from "../testing/index.ts";

/*
 * `POST /v1/workspaces/:id/search`, through the real app on the API's fakes: what it finds,
 * what it never shows, and what it never says. The access matrix and the ranking are proved on
 * the database (packages/db's search.access and search.rank tests); these prove the route.
 */

let t: TestApp;
let ws: Workspace;
const PEOPLE: Record<string, Access> = { maya: "admin", ines: "read", omar: "none" };
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, PEOPLE);
});
afterAll(() => t.close());

const as = (login: string) => ws.people[login]!.headers;
const userId = (login: string) => ws.people[login]!.userId;

const search = (headers: Record<string, string>, body: unknown, workspaceId = ws.id) =>
  call(t, headers, "POST", `/v1/workspaces/${workspaceId}/search`, body);

/** The canvas ids of each group of an answer, for a short assertion. */
const idsOf = (answer: any) => ({
  canvases: answer.canvases.map((hit: any) => hit.canvasId),
  boards: answer.boards.map((hit: any) => hit.canvasId),
  comments: answer.comments.map((hit: any) => hit.canvasId),
  messages: answer.messages.map((hit: any) => hit.canvasId),
  pullRequests: answer.pullRequests.map((hit: any) => hit.canvasId),
});

const thread = (id: string, messages: Thread["messages"], extra: Partial<Thread> = {}): Thread => ({
  id,
  artboardId: "ab_1",
  x: 1,
  y: 2,
  status: "open",
  createdAt: 1_000,
  updatedAt: 1_000,
  messages,
  ...extra,
});

/** A canvas named `name`, with a page, a board and comments that all carry `word`. */
function docWith(name: string, word: string, threads: Thread[] = []): Doc {
  return {
    ...emptyDoc(name),
    pages: [
      {
        id: "pg_1",
        name: `${word} page`,
        artboards: [{ id: "ab_1", name: `${word} board`, x: 0, y: 0, root: el("ab_1", "section") }],
      },
    ],
    threads,
  };
}

describe("what search finds", () => {
  test("a canvas's name, its pages and boards, and its comments, with where each matches", async () => {
    const doc = docWith("Okapi launch", "okapi", [
      thread("th_1", [
        {
          id: "m_1",
          author: { kind: "user", id: userId("maya"), name: "Maya" },
          text: "Is the okapi too big here?",
          createdAt: 5_000,
        },
      ]),
    ]);
    const canvas = await canvasIn(t, ws, "maya", doc);

    const { status, body } = await search(as("ines"), { q: "  okapi  " });

    expect(status).toBe(200);
    expect(body).toEqual({
      query: "okapi",
      canvases: [{ canvasId: canvas.id, name: "Okapi launch", matches: [[0, 5]] }],
      // One tier and one canvas, so by kind: board before page.
      boards: [
        {
          canvasId: canvas.id,
          canvasName: "Okapi launch",
          kind: "board",
          id: "ab_1",
          pageId: "pg_1",
          name: "okapi board",
          matches: [[0, 5]],
        },
        {
          canvasId: canvas.id,
          canvasName: "Okapi launch",
          kind: "page",
          id: "pg_1",
          pageId: null,
          name: "okapi page",
          matches: [[0, 5]],
        },
      ],
      comments: [
        {
          canvasId: canvas.id,
          canvasName: "Okapi launch",
          threadId: "th_1",
          messageId: "m_1",
          pageId: "pg_1",
          artboardId: "ab_1",
          resolved: false,
          snippet: "Is the okapi too big here?",
          matches: [[7, 12]],
          author: {
            kind: "user",
            id: userId("maya"),
            name: "Maya",
            login: "maya",
            avatarUrl: "https://avatars.example/maya",
          },
          at: new Date(5_000).toISOString(),
        },
      ],
      messages: [],
      pullRequests: [],
      people: [],
    });
  });

  test("the groups asked for, and no others", async () => {
    await canvasIn(t, ws, "maya", docWith("Tapir notes", "tapir"));

    const { body } = await search(as("maya"), { q: "tapir", groups: ["boards"] });

    expect(body.canvases).toEqual([]);
    expect(body.boards.map((hit: any) => hit.name)).toEqual(["tapir board", "tapir page"]);
  });

  test("a person's message and the agent's answer, but never an aside or an unfinished turn's words", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", docWith("Chat", "chat"));
    const sent = await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, {
      text: "Draw the narwhal pricing page",
    });
    expect(sent.status).toBe(201);
    const [work, aside, answer, running, said] = [1, 2, 3, 4, 5].map(() => newId("ti")) as [
      string,
      string,
      string,
      string,
      string,
    ];
    const turn = (ended: "done" | "failed" | null, final: string | null) => ({
      ended,
      ms: 10,
      final,
      boards: 0,
      files: 0,
      log: [],
    });
    const wrote = await call(t, runner.headers, "POST", "/v1/runner/thread", {
      items: [
        {
          id: work,
          kind: "tool",
          streaming: false,
          payload: { label: "Worked", steps: 1, artboards: [], turn: turn("done", answer) },
        },
        {
          id: aside,
          kind: "assistant",
          streaming: false,
          payload: { text: "Thinking about the narwhal aside" },
        },
        {
          id: answer,
          kind: "assistant",
          streaming: false,
          payload: {
            text: "## Done\n\n- The **narwhal** tier\n- [Pricing](https://x.test/narwhal)",
          },
        },
        // A second turn, still running, which has said something.
        {
          id: running,
          kind: "tool",
          streaming: true,
          payload: { label: "Working", steps: 1, artboards: [], turn: turn(null, null) },
        },
        { id: said, kind: "assistant", streaming: false, payload: { text: "A narwhal draft" } },
      ],
    });
    expect(wrote.status).toBe(200);

    const { body } = await search(as("ines"), { q: "narwhal" });

    expect(body.messages).toEqual([
      expect.objectContaining({
        itemId: answer,
        // Each block on a line of its own, and a snippet shows a line break as a space.
        snippet: "Done The narwhal tier Pricing",
        matches: [[9, 16]],
        author: { kind: "agent" },
      }),
      expect.objectContaining({
        itemId: sent.body.id,
        itemSeq: sent.body.seq,
        snippet: "Draw the narwhal pricing page",
        author: expect.objectContaining({ kind: "user", id: userId("maya") }),
      }),
    ]);
    // The link's address is not words anyone reads.
    expect((await search(as("ines"), { q: "x.test" })).body.messages).toEqual([]);
  });

  test("a turn that failed before it answered leaves nothing to find", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", docWith("Failed", "fail"));
    const [work, said] = [newId("ti"), newId("ti")];
    await call(t, runner.headers, "POST", "/v1/runner/thread", {
      items: [
        {
          id: work,
          kind: "tool",
          streaming: false,
          payload: {
            label: "Worked",
            steps: 1,
            artboards: [],
            turn: { ended: "failed", ms: 1, final: null, boards: 0, files: 0, log: [] },
          },
        },
        { id: said, kind: "assistant", streaming: false, payload: { text: "A wombat half-said" } },
      ],
    });

    expect((await search(as("maya"), { q: "wombat" })).body.messages).toEqual([]);
    expect((await listSearchEntries(t.db, canvas.id)).map((e) => e.kind).sort()).toEqual([
      "board",
      "canvas",
      "page",
    ]);
  });

  test("the first message of a canvas made with one", async () => {
    const created = await call(t, as("maya"), "POST", "/v1/canvases", {
      workspaceId: ws.id,
      repoId: ws.repo.id,
      message: { text: "Sketch a quetzal onboarding" },
    });
    expect(created.status).toBe(201);

    const { body } = await search(as("maya"), { q: "quetzal" });

    expect(body.messages.map((hit: any) => [hit.canvasId, hit.snippet])).toEqual([
      [created.body.id, "Sketch a quetzal onboarding"],
    ]);
  });

  test("a pull request by its title or number, with its state only while it is the canvas's", async () => {
    const canvas = await canvasIn(t, ws, "maya", docWith("Release", "release"));
    const read = (number: number, title: string, state: "open" | "merged") =>
      recordPullRequestRead(t.db, {
        canvasId: canvas.id,
        number,
        title,
        state,
        checks: "none",
        mergeable: true,
        autoMerge: false,
        updatedAt: new Date(t.clock.now()),
        readAt: new Date(t.clock.now()),
      });
    await read(411, "Add the ibex pricing", "open");
    await read(412, "Ship the ibex pricing", "open");

    const byTitle = (await search(as("ines"), { q: "ibex" })).body.pullRequests;
    const byNumber = (await search(as("ines"), { q: "#411" })).body.pullRequests;

    expect(byTitle.map((hit: any) => [hit.number, hit.title, hit.matches, hit.state])).toEqual([
      [411, "Add the ibex pricing", [[8, 12]], null],
      [412, "Ship the ibex pricing", [[9, 13]], "open"],
    ]);
    expect(byNumber.map((hit: any) => [hit.number, hit.matches])).toEqual([[411, []]]);
  });
});

describe("what search never shows", () => {
  test("only canvases the sidebar lists: another person's Scratch and a repo answered none are not", async () => {
    const inRepo = await canvasIn(t, ws, "maya", docWith("Gecko repo", "gecko"));
    const mayas = await canvasIn(t, ws, "maya", docWith("Gecko scratch", "gecko"), "scratch");
    const ines = await canvasIn(t, ws, "ines", docWith("Gecko ines", "gecko"), "scratch");

    const forInes = idsOf((await search(as("ines"), { q: "gecko" })).body);
    const forOmar = idsOf((await search(as("omar"), { q: "gecko" })).body);
    const listed = (login: string) =>
      call(t, as(login), "GET", `/v1/workspaces/${ws.id}/canvases`).then(({ body }) =>
        body.canvases.map((canvas: any) => canvas.id),
      );

    expect(forInes.canvases.sort()).toEqual([inRepo.id, ines.id].sort());
    expect(forInes.boards).not.toContain(mayas.id);
    expect(forOmar.canvases).toEqual([]);
    expect(forOmar.boards).toEqual([]);
    for (const login of ["ines", "omar", "maya"]) {
      const answer = idsOf((await search(as(login), { q: "gecko" })).body);
      const all = Object.values(answer).flat();
      const list = await listed(login);
      expect(all.every((id) => list.includes(id))).toBe(true);
    }
  });

  test("a repo the person lost leaves search within the minute, as it leaves the list", async () => {
    const lost = await workspaceWithRepo(t, { pia: "admin", rex: "read" });
    const canvas = await canvasIn(t, lost, "pia", docWith("Lemur", "lemur"));
    const rex = lost.people.rex!.headers;
    const find = async () =>
      idsOf((await search(rex, { q: "lemur" }, lost.id)).body).canvases as string[];

    expect(await find()).toEqual([canvas.id]);
    lost.grant("rex", "none");
    expect(await find()).toEqual([canvas.id]);
    t.clock.advance(61_000);
    expect(await find()).toEqual([]);
  });

  test("a workspace someone is not in is not found, word for word as one that does not exist", async () => {
    const outsider = await t.signInAs({ login: "outsider" });
    await canvasIn(t, ws, "maya", docWith("Secret serval", "serval"));

    const theirs = await t.app.request(`/v1/workspaces/${ws.id}/search`, {
      method: "POST",
      headers: { ...outsider.headers, "content-type": "application/json" },
      body: JSON.stringify({ q: "serval" }),
    });
    const nowhere = await t.app.request("/v1/workspaces/ws_nothing/search", {
      method: "POST",
      headers: { ...outsider.headers, "content-type": "application/json" },
      body: JSON.stringify({ q: "serval" }),
    });

    expect(theirs.status).toBe(404);
    expect(nowhere.status).toBe(404);
    expect(await theirs.text()).toBe(await nowhere.text());
  });

  test("no canvas's asset key, in any group", async () => {
    const canvas = await canvasIn(t, ws, "maya", docWith("Asset aardvark", "aardvark"));
    await call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, {
      text: "the aardvark board",
    });

    const { body } = await search(as("maya"), { q: "aardvark" });
    const json = JSON.stringify(body);

    expect(body.canvases).toHaveLength(1);
    expect(body.messages).toHaveLength(1);
    const assetKey = await getCanvasAssetKey(t.db, canvas.id);
    expect(assetKey).toBeTruthy();
    expect(json).not.toContain(assetKey!);
    expect(json).not.toContain(ws.repo.fullName);
  });

  test("a person who deleted their account is 'deleted', and their name is not kept", async () => {
    const gone = "usr_gone00000000000000";
    const canvas = await canvasIn(
      t,
      ws,
      "maya",
      docWith("Ghost", "ghost", [
        thread("th_9", [
          {
            id: "m_9",
            author: { kind: "user", id: gone, name: "Gwen Former" },
            text: "a ghost comment",
            createdAt: 1_000,
          },
          {
            id: "m_10",
            author: { kind: "agent", name: "Claude" },
            text: "a ghost reply",
            createdAt: 2_000,
          },
        ]),
      ]),
    );

    const { body } = await search(as("maya"), { q: "ghost comment" });
    const reply = (await search(as("maya"), { q: "ghost reply" })).body.comments;

    expect(body.comments.map((hit: any) => hit.author)).toEqual([{ kind: "deleted" }]);
    expect(reply.map((hit: any) => hit.author)).toEqual([{ kind: "agent" }]);
    const stored = (await listSearchEntries(t.db, canvas.id)).find((e) => e.ref === "th_9/m_9");
    expect(stored?.authorName).toBe("Deleted user");
  });
});

describe("what search takes", () => {
  test("words of 1 to 200 characters after trimming; punctuation alone answers nothing", async () => {
    const long = await search(as("maya"), { q: "x".repeat(201) });
    const most = await search(as("maya"), { q: ` ${"x".repeat(200)} ` });
    const blank = await search(as("maya"), { q: "   " });
    const unknownGroup = await search(as("maya"), { q: "x", groups: ["everything"] });
    const punctuation = await search(as("maya"), { q: "%_\\ -- !!" });

    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe("invalid_request");
    expect(most.status).toBe(200);
    expect(blank.status).toBe(400);
    expect(unknownGroup.status).toBe(400);
    expect(punctuation.status).toBe(200);
    expect(punctuation.body).toEqual({
      query: "%_\\ -- !!",
      canvases: [],
      boards: [],
      comments: [],
      messages: [],
      pullRequests: [],
      people: [],
    });
  });

  test("LIKE's % and _ and a backslash are never wildcards: they are spaces", async () => {
    const named = async (name: string) => (await canvasIn(t, ws, "maya", docWith(name, "x"))).id;
    const thousand = await named("Plan 1000");
    const hundred = await named("Plan 100");
    await named("Plan 1x0");
    const under = await named("a_b keys");
    await named("axb keys");
    const names = async (q: string) =>
      (await search(as("maya"), { q, groups: ["canvases"] })).body.canvases.map(
        (hit: any) => hit.canvasId,
      );

    // '100%' is the term 100, found anywhere: what '100' finds, and no more.
    expect(await names("100%")).toEqual(await names("100"));
    expect((await names("100")).sort()).toEqual([thousand, hundred].sort());
    expect(await names("1%0")).toEqual([]);
    expect(await names("a_b")).toEqual([under]);
    expect(await names("a\\b")).toEqual([under]);
  });
});

describe("what search never says", () => {
  test("its log line and its event carry counts and times, never the words", async () => {
    await canvasIn(t, ws, "maya", docWith("Pangolin plan", "pangolin"));
    const logged = t.logs.length;
    const captured = t.analytics.events.length;

    const { body } = await search(as("maya"), { q: "pangolin plan" });

    expect(body.canvases).toHaveLength(1);
    const lines = t.logs.slice(logged);
    const events = t.analytics.events.slice(captured);
    expect(JSON.stringify(lines)).not.toContain("pangolin");
    expect(JSON.stringify(events)).not.toContain("pangolin");
    expect(lines.find((line) => line.event === "search")).toMatchObject({
      level: "info",
      workspaceId: ws.id,
      terms: 2,
      q_len: 13,
      canvases: 1,
      boards: 0,
      people: 0,
    });
    expect(events.find((e) => e.event === "search answered")).toMatchObject({
      properties: {
        q_length: 13,
        terms: 2,
        results: 1,
        groups: ["canvases"],
        ms: expect.any(Number),
        workspace_id: ws.id,
      },
    });
    // The request's own line has the route's path, and the body is never logged.
    expect(lines.some((line) => JSON.stringify(line).includes(`/workspaces/${ws.id}/search`))).toBe(
      true,
    );
  });
});

describe("people", () => {
  let nextGithubId = 95_000;

  /** An organization whose owner and members are in Ponzu, and collaborators on one repo. */
  async function team(
    login: string,
    {
      owners,
      members = [],
      collaborators = [],
      strangers = [],
    }: {
      owners: SignedInPerson[];
      members?: SignedInPerson[];
      collaborators?: SignedInPerson[];
      strangers?: number[];
    },
  ) {
    const inOrg = Object.fromEntries(
      [...owners, ...members].map((person) => [person.github.id, "write" as const]),
    );
    const outside = Object.fromEntries([
      ...collaborators.map((person) => [person.github.id, "read" as const]),
      ...strangers.map((id) => [id, "read" as const]),
    ]);
    const installation: FakeInstallation = {
      id: nextGithubId++,
      account: {
        id: nextGithubId++,
        login,
        type: "Organization",
        owners: owners.map((person) => person.github.id),
        members: [...members.map((person) => person.github.id), ...strangers],
      },
      repositorySelection: "selected",
      repositories: [
        { id: nextGithubId++, fullName: `${login}/web`, access: { ...inOrg, ...outside } },
      ],
    };
    t.github.installations.push(installation);
    for (const person of [...owners, ...members, ...collaborators]) {
      await t.app.request("/v1/github/sync", { method: "POST", headers: person.headers });
    }
    const switcher = await call(t, owners[0]!.headers, "GET", "/v1/workspaces");
    return switcher.body.workspaces.find((w: any) => w.githubLogin === login).id as string;
  }

  test("joined people by name or login, as GitHub would show them; a collaborator sees only themself", async () => {
    const owner = await t.signInAs({ login: "harriet", name: "Harriet Vole" });
    const member = await t.signInAs({ login: "volemaster", name: "Ivo Ng" });
    const other = await t.signInAs({ login: "jun", name: "Jun Vole" });
    const outside = await t.signInAs({ login: "kit-vole", name: "Kit" });
    // In the organization on GitHub, but has never opened Ponzu: nothing to filter by.
    const stranger = t.github.addUser({
      id: nextGithubId++,
      login: "vole-stranger",
      name: "Vole Stranger",
      avatarUrl: null,
      emails: [],
    });
    const workspaceId = await team("voles", {
      owners: [owner],
      members: [member, other],
      collaborators: [outside],
      strangers: [stranger.id],
    });
    await t.backgroundDone();
    const known = await listWorkspacePeople(t.db, { workspaceId, viewerUserId: owner.userId });
    expect(known.find((person) => person.githubLogin === "vole-stranger")?.userId).toBeNull();

    const forOwner = (await search(owner.headers, { q: "vole" }, workspaceId)).body.people;
    const forOutside = (await search(outside.headers, { q: "vole" }, workspaceId)).body.people;
    const short = (await search(owner.headers, { q: "ng" }, workspaceId)).body.people;

    // volemaster's login starts with it; the rest have it at a word start: the admin, then by name.
    expect(forOwner.map((p: any) => p.login)).toEqual(["volemaster", "harriet", "jun", "kit-vole"]);
    expect(forOwner.find((p: any) => p.login === "volemaster")).toEqual({
      userId: member.userId,
      login: "volemaster",
      name: "Ivo Ng",
      avatarUrl: "https://avatars.example/volemaster",
      nameMatches: [],
      loginMatches: [[0, 4]],
    });
    expect(forOutside.map((p: any) => p.login)).toEqual(["kit-vole"]);
    // A short term only at a word start: Ng, not the ng inside harriet's or jun's words.
    expect(short.map((p: any) => p.login)).toEqual(["volemaster"]);
  });

  test("at most four, the whole name first, then admins", async () => {
    const owner = await t.signInAs({ login: "lynx-a", name: "Lynx" });
    const rest = await Promise.all(
      ["b", "c", "d", "e"].map((s) => t.signInAs({ login: `lynx-${s}`, name: `Zed Lynx ${s}` })),
    );
    const workspaceId = await team("lynxes", { owners: [owner], members: rest });
    const promoted = await call(
      t,
      owner.headers,
      "PATCH",
      `/v1/workspaces/${workspaceId}/members/${rest[3]!.userId}`,
      { role: "admin" },
    );
    expect(promoted.status).toBe(200);

    const people = (await search(rest[0]!.headers, { q: "lynx" }, workspaceId)).body.people;

    expect(people.map((p: any) => p.login)).toEqual(["lynx-a", "lynx-e", "lynx-b", "lynx-c"]);
  });
});
