import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { emptyDoc } from "@ponzu/core";
import {
  type Canvas,
  createCanvas,
  getRepoAccess,
  getWorkspaceByInstallation,
  notifyCanvasFacts,
  recordRepoAccess,
} from "@ponzu/db";
import { syncGithub } from "../github/sync.ts";
import { canvasFactsOf } from "../notifications/facts.ts";
import { canRead } from "../notifications/recipients.ts";
import { call } from "../testing/canvases.ts";
import {
  createTestApp,
  type FakeInstallation,
  type FakeRepository,
  type SignedInPerson,
  type TestApp,
} from "../testing/index.ts";
import { repoPermission } from "./repo-access.ts";

/*
 * Who may see a canvas on a PUBLIC repository (docs/cloud.md, "Identity and access"): only
 * people GitHub has given the repository to, with any permission (a member or owner of the
 * organization that owns it, one of its collaborators, read-only outside collaborators
 * included, or the personal account that owns it). Someone whose only tie to it is that it is
 * public gets, from every route, list, search and live query, exactly what they would get for a
 * canvas that does not exist. A PRIVATE repository keeps the rule it had: read to open, push to
 * steer.
 *
 * Each world below is a workspace with two repos, `main` (public or private) and `side`
 * (private), seen by everyone a GitHub account can be to `main`:
 *
 *   pusher         outside collaborator with push on main
 *   orgOwner       owner of the organization (GitHub gives owners admin on every repo)
 *   orgReader      member of the organization, given main read-only
 *   orgMember      member of the organization, given only side
 *   outsideReader  outside collaborator given main read-only
 *   stranger       outside collaborator given only side: main is public to them, nothing more
 *   formerOwner    made the canvas with push on main, then lost main; still has side
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

let nextId = 81_001;
const UNKNOWN = "cnv_00000000000000000000000000";

type Need = "read" | "write";
type Answer = "write" | "read" | "none";

const ORG_PEOPLE = [
  "pusher",
  "orgOwner",
  "orgReader",
  "orgMember",
  "outsideReader",
  "stranger",
  "formerOwner",
] as const;
type OrgPerson = (typeof ORG_PEOPLE)[number];

interface World {
  workspaceId: string;
  main: { id: string; fullName: string; fake: FakeRepository };
  side: { id: string };
  canvas: Canvas;
  people: Record<string, SignedInPerson>;
  installation: FakeInstallation;
}

async function signIn(tag: number, names: readonly string[]) {
  const people: Record<string, SignedInPerson> = {};
  for (const name of names) {
    people[name] = await t.signInAs({ login: `${name.toLowerCase()}-${tag}` });
  }
  return people;
}

/** The database's own client, to run a statement as written. */
const pg = () =>
  (t.db as unknown as { $client: { query(sql: string, params?: unknown[]): any } }).$client;

async function repoRow(githubRepoId: number): Promise<{ id: string; fullName: string }> {
  const { rows } = await pg().query(
    `select id, full_name as "fullName" from repos where github_repo_id = $1`,
    [githubRepoId],
  );
  return rows[0];
}

/** Install the App on `installation`, sync everyone, and make the canvas on main. */
async function settle(
  installation: FakeInstallation,
  people: Record<string, SignedInPerson>,
  canvasOwner: string,
  word: string,
): Promise<World> {
  t.github.installations.push(installation);
  for (const person of Object.values(people)) await syncGithub(t.deps, person.userId);
  const workspace = (await getWorkspaceByInstallation(t.db, installation.id))!;
  const [mainFake, sideFake] = installation.repositories as [FakeRepository, FakeRepository];
  const main = await repoRow(mainFake.id);
  const side = await repoRow(sideFake.id);
  const canvas = await createCanvas(t.db, {
    workspaceId: workspace.id,
    repoId: main.id,
    ownerId: people[canvasOwner]!.userId,
    claudeAccountId: null,
    name: `${word} launch`,
    branch: null,
    doc: emptyDoc(`${word} launch`),
  });
  return {
    workspaceId: workspace.id,
    main: { id: main.id, fullName: main.fullName, fake: mainFake },
    side: { id: side.id },
    canvas,
    people,
    installation,
  };
}

/** An organization's workspace, as in the table at the top. */
async function orgWorld(visibility: "public" | "private"): Promise<World> {
  const tag = nextId;
  nextId += 10;
  const people = await signIn(tag, ORG_PEOPLE);
  const id = (who: OrgPerson) => people[who]!.github.id;
  const login = `northbrook-${tag}`;
  const main: FakeRepository = {
    id: tag + 1,
    fullName: `${login}/ponzu`,
    private: visibility === "private",
    access: {
      [id("pusher")]: "write",
      [id("orgReader")]: "read",
      [id("outsideReader")]: "read",
      [id("formerOwner")]: "write",
    },
  };
  const side: FakeRepository = {
    id: tag + 2,
    fullName: `${login}/ponzu-test`,
    private: true,
    access: {
      [id("orgMember")]: "write",
      [id("stranger")]: "write",
      [id("formerOwner")]: "write",
    },
  };
  const installation: FakeInstallation = {
    id: tag + 3,
    account: {
      id: tag + 4,
      login,
      type: "Organization",
      owners: [id("orgOwner")],
      members: [id("orgReader"), id("orgMember")],
    },
    repositorySelection: "all",
    repositories: [main, side],
  };
  const world = await settle(installation, people, "formerOwner", `Marigold${tag}`);
  // The canvas's owner loses main; GitHub says so and their next sync hears it.
  delete main.access[id("formerOwner")];
  await syncGithub(t.deps, people.formerOwner!.userId);
  return world;
}

/** A personal account's workspace: its owner, a read-only collaborator, and a stranger. */
async function personalWorld(visibility: "public" | "private"): Promise<World> {
  const tag = nextId;
  nextId += 10;
  const people = await signIn(tag, ["owner", "reader", "stranger"]);
  const id = (who: string) => people[who]!.github.id;
  const login = people.owner!.github.login;
  const main: FakeRepository = {
    id: tag + 1,
    fullName: `${login}/site`,
    private: visibility === "private",
    access: { [id("reader")]: "read" },
  };
  const side: FakeRepository = {
    id: tag + 2,
    fullName: `${login}/notes`,
    private: true,
    access: { [id("stranger")]: "write" },
  };
  const installation: FakeInstallation = {
    id: tag + 3,
    account: { id: id("owner"), login, type: "User" },
    repositorySelection: "all",
    repositories: [main, side],
  };
  return settle(installation, people, "owner", `Juniper${tag}`);
}

/** What each person may do with the canvas, by world. */
const ORG_EXPECTED: Record<"public" | "private", Record<OrgPerson, Answer>> = {
  public: {
    pusher: "write",
    orgOwner: "write",
    orgReader: "read",
    orgMember: "read",
    outsideReader: "read",
    stranger: "none",
    formerOwner: "none",
  },
  private: {
    pusher: "write",
    orgOwner: "write",
    orgReader: "read",
    orgMember: "none",
    outsideReader: "read",
    stranger: "none",
    formerOwner: "none",
  },
};
const PERSONAL_EXPECTED: Record<string, Answer> = {
  owner: "write",
  reader: "read",
  stranger: "none",
};

/*
 * Every route that takes a canvas id, with a request its validation takes, so the request
 * reaches the access check. A route added under /v1/canvases/:id without a line here fails
 * "the table names every canvas route" below.
 */
interface CanvasRoute {
  method: string;
  /** As Hono registers it. */
  path: string;
  url(id: string): string;
  body?: unknown;
  /** What `requireCanvas` is asked for; `none` for a route that touches only the caller's own row. */
  need: Need | "none";
}

const sha = "a".repeat(64);
const file = (name: string, contentType: string) => ({ name, contentType, size: 4, sha256: sha });
const head = "b".repeat(40);
const route = (
  method: string,
  tail: string,
  need: CanvasRoute["need"],
  extra: { body?: unknown; query?: string } = {},
): CanvasRoute => ({
  method,
  path: `/v1/canvases/:id${tail}`,
  url: (id) =>
    `/v1/canvases/${id}${tail
      .replace(":questionId", "q_1")
      .replace(":messageId", "m_1")
      .replace(":repoId", "rep_1")
      .replace(":number", "1")}${extra.query ?? ""}`,
  body: extra.body,
  need,
});

const CANVAS_ROUTES: CanvasRoute[] = [
  route("GET", "", "read"),
  route("GET", "/people", "read"),
  route("PATCH", "", "write", { body: { name: "Renamed" } }),
  route("DELETE", "", "write"),
  route("POST", "/asset-key/rotate", "write"),
  route("POST", "/take-over", "write"),
  route("GET", "/doc", "read"),
  route("GET", "/ops", "read", { query: "?after=0" }),
  route("POST", "/ops", "write", { body: { ops: [] } }),
  route("POST", "/undo", "write"),
  route("POST", "/redo", "write"),
  route("PUT", "/presence", "read", { body: {} }),
  route("DELETE", "/presence", "none"),
  route("POST", "/seen", "read", { body: {} }),
  route("POST", "/messages", "write", { body: { text: "hello" } }),
  route("POST", "/questions/:questionId/answer", "write", { body: { approved: true } }),
  route("POST", "/questions/:questionId/secret", "write", { body: { value: "s3cret" } }),
  route("GET", "/questions/:questionId", "read"),
  route("POST", "/stop", "write"),
  route("GET", "/thread", "read"),
  route("POST", "/uploads", "write", { body: { files: [file("a.png", "image/png")] } }),
  route("POST", "/uploads/complete", "write", { body: { ids: ["up_1"] } }),
  route("POST", "/comments/:messageId/picture", "write", {
    body: { files: [file("light.webp", "image/webp"), file("dark.webp", "image/webp")] },
  }),
  route("POST", "/comments/:messageId/picture/complete", "write", { body: { ids: ["up_1"] } }),
  route("GET", "/pull-request", "read"),
  route("GET", "/pull-request/files", "read", { query: "?path=a.txt" }),
  route("POST", "/pull-request", "write"),
  route("POST", "/pull-request/ready", "write"),
  route("POST", "/pull-request/merge", "write", { body: { headSha: head } }),
  route("POST", "/pull-request/auto-merge", "write"),
  route("DELETE", "/pull-request/auto-merge", "write"),
  route("POST", "/pull-request/close", "write"),
  route("POST", "/pull-request/update-branch", "write", { body: { headSha: head } }),
  route("PUT", "/driver", "write", { body: {} }),
  route("DELETE", "/driver", "write"),
  route("GET", "/pull-requests", "read"),
  route("POST", "/pull-requests", "write", {
    body: { urls: ["https://github.com/acme/web/pull/1"] },
  }),
  route("DELETE", "/pull-requests/:repoId/:number", "write"),
];

const LIVE_CANVAS_QUERIES = ["canvas.head", "canvas.thread", "canvas.questions", "canvas.presence"];

const ask = (headers: Record<string, string>, r: CanvasRoute, id: string) =>
  call(t, headers, r.method, r.url(id), r.body);

const live = (headers: Record<string, string>, queries: { name: string; args?: unknown }[]) =>
  call(t, headers, "POST", "/v1/live", { queries });

/** What an id that names no canvas gets: the answer nobody can tell a hidden canvas from. */
const NO_SUCH_CANVAS = { status: 404, body: { error: { code: "not_found" } } };

/**
 * Everything a stranger could learn the canvas from, asked as `person`, and the same asked of
 * an id that names nothing. They must be equal, word for word.
 */
async function everyAnswer(person: SignedInPerson, id: string) {
  const answers: Record<string, unknown> = {};
  for (const r of CANVAS_ROUTES) {
    const { status, body } = await ask(person.headers, r, id);
    answers[`${r.method} ${r.path}`] = { status, body };
  }
  const watched = await live(
    person.headers,
    LIVE_CANVAS_QUERIES.map((name) => ({ name, args: { canvasId: id } })),
  );
  answers.live = watched.body.results.map((result: any) => result.error ?? "sealed");
  return answers;
}

/** What the person is shown of the workspace: its canvases, repos, search and live list. */
async function workspaceView(world: World, person: SignedInPerson) {
  const { headers } = person;
  const listed = await call(t, headers, "GET", `/v1/workspaces/${world.workspaceId}/canvases`);
  const profile = await call(t, headers, "GET", `/v1/workspaces/${world.workspaceId}`);
  const found = await call(t, headers, "POST", `/v1/workspaces/${world.workspaceId}/search`, {
    q: world.canvas.name.split(" ")[0],
  });
  const ideas = await call(t, headers, "GET", `/v1/repos/${world.main.id}/ideas`);
  const environment = await call(t, headers, "GET", `/v1/repos/${world.main.id}/environment`);
  const usage = await call(t, headers, "GET", `/v1/workspaces/${world.workspaceId}/usage`);
  const sealed = await live(headers, [
    { name: "workspace.canvases", args: { workspaceId: world.workspaceId } },
  ]);
  const { sql, params } = JSON.parse(
    sealed.body.results[0].sealed.capability.slice("sealed:".length),
  ) as { sql: string; params: string[] };
  const watched = (await pg().query(sql, params)).rows;
  return {
    listed: listed.body.canvases.map((row: { id: string }) => row.id),
    repos: profile.body.repos.map((repo: { id: string }) => repo.id),
    found: found.body.canvases.map((hit: { canvasId: string }) => hit.canvasId),
    ideas: ideas.status,
    environment: environment.status,
    usage: JSON.stringify(usage.body).includes(world.canvas.id),
    watched: watched.map((row: { id: string }) => row.id),
  };
}

/** Each way to read the rule: within the minute (the list's answers) and after (asked again). */
const MOMENTS = ["fresh", "a minute later"] as const;

function runMatrix(name: string, make: () => Promise<World>, expected: Record<string, Answer>) {
  describe(name, () => {
    let world: World;
    beforeAll(async () => {
      world = await make();
    });

    for (const moment of MOMENTS) {
      describe(moment, () => {
        // Past the minute an answer is taken as it is: each is asked of GitHub again.
        beforeAll(() => {
          if (moment === "a minute later") t.clock.advance(61_000);
        });
        for (const [who, answer] of Object.entries(expected)) {
          test(`${who} ${answer === "none" ? "cannot tell the canvas exists" : `can ${answer}`}`, async () => {
            const person = world.people[who]!;

            if (answer === "none") {
              const real = await everyAnswer(person, world.canvas.id);
              const unknown = await everyAnswer(person, UNKNOWN);
              expect(real).toEqual(unknown);
              // And those answers are the access check's, not a validation's.
              for (const r of CANVAS_ROUTES.filter((r) => r.need !== "none")) {
                expect(real[`${r.method} ${r.path}`]).toMatchObject(NO_SUCH_CANVAS);
              }
              expect(real.live).toEqual(
                LIVE_CANVAS_QUERIES.map(() => expect.objectContaining({ code: "not_found" })),
              );
              const view = await workspaceView(world, person);
              expect(view).toMatchObject({
                listed: [],
                found: [],
                ideas: 404,
                environment: 404,
                usage: false,
                watched: [],
              });
              expect(view.repos).not.toContain(world.main.id);
              return;
            }

            const opened = await call(t, person.headers, "GET", `/v1/canvases/${world.canvas.id}`);
            expect(opened.status).toBe(200);
            expect(opened.body.access).toBe(answer);
            const view = await workspaceView(world, person);
            expect(view.listed).toContain(world.canvas.id);
            expect(view.repos).toContain(world.main.id);
            expect(view.found).toContain(world.canvas.id);
            expect(view.watched).toContain(world.canvas.id);
            const watched = await live(
              person.headers,
              LIVE_CANVAS_QUERIES.map((q) => ({ name: q, args: { canvasId: world.canvas.id } })),
            );
            expect(watched.body.results.every((result: any) => result.sealed)).toBe(true);

            if (answer === "read") {
              for (const r of CANVAS_ROUTES) {
                const { status, body } = await ask(person.headers, r, world.canvas.id);
                const said = `${r.method} ${r.path} answered ${status} ${JSON.stringify(body)}`;
                if (r.need === "write") {
                  expect(said).toContain(`answered 403 {"error":{"code":"forbidden"`);
                } else {
                  // Whatever a reader gets, it is not the answer for a canvas that is not there.
                  expect(said).not.toContain("There is no such canvas.");
                  expect(status).not.toBe(403);
                }
              }
            }
          });
        }
      });
    }

    test("a ping about the canvas reaches only those who may read it", async () => {
      const facts = canvasFactsOf((await notifyCanvasFacts(t.db, { canvasId: world.canvas.id }))!);
      const now = new Date(t.clock.now());
      // The canvas's own owner included: owning it gives nothing once GitHub takes the repo.
      const heard = Object.keys(expected).map((who) => [
        who,
        canRead(facts, world.people[who]!.userId, now),
      ]);
      expect(heard).toEqual(
        Object.entries(expected).map(([who, answer]) => [who, answer !== "none"]),
      );
    });
  });
}

runMatrix("an organization's public repo", () => orgWorld("public"), ORG_EXPECTED.public);
runMatrix(
  "an organization's private repo (today's rule)",
  () => orgWorld("private"),
  ORG_EXPECTED.private,
);
runMatrix("a personal account's public repo", () => personalWorld("public"), PERSONAL_EXPECTED);
runMatrix(
  "a personal account's private repo (today's rule)",
  () => personalWorld("private"),
  PERSONAL_EXPECTED,
);

describe("the next route cannot forget", () => {
  test("the table names every canvas route the app ships", () => {
    const shipped = t.app.routes
      .filter((r) => r.method !== "ALL" && r.path.startsWith("/v1/canvases/:id"))
      .map((r) => `${r.method} ${r.path}`);
    const named = CANVAS_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect([...new Set(shipped)].sort()).toEqual([...new Set(named)].sort());
  });

  test("every live query about a canvas is authorized by opening it", async () => {
    const { LIVE_QUERIES } = await import("../live/queries.ts");
    const aboutCanvas = Object.keys(LIVE_QUERIES).filter((name) => name.startsWith("canvas."));
    expect(aboutCanvas.sort()).toEqual([...LIVE_CANVAS_QUERIES].sort());
  });

  test("a person's token opens none of the runner's routes", async () => {
    const world = await orgWorld("public");
    const runnerRoutes = t.app.routes.filter(
      (r) => r.method !== "ALL" && r.path.startsWith("/v1/runner/"),
    );
    expect(runnerRoutes.length).toBeGreaterThan(10);
    for (const r of runnerRoutes) {
      const { status } = await call(t, world.people.pusher!.headers, r.method, r.path, {});
      expect(`${r.method} ${r.path} ${status}`).toBe(`${r.method} ${r.path} 401`);
    }
  });
});

describe("a repo changing visibility", () => {
  test("public to private: a member GitHub gave nothing of it loses it at once", async () => {
    const world = await orgWorld("public");
    const member = world.people.orgMember!;
    const open = async () =>
      (await call(t, member.headers, "GET", `/v1/canvases/${world.canvas.id}`)).status;
    expect(await open()).toBe(200);

    world.main.fake.private = true;
    const response = await t.app.request(
      "/v1/github/webhook",
      t.github.delivery("repository", {
        action: "privatized",
        repository: { id: world.main.fake.id },
        installation: { id: world.installation.id },
      }),
    );
    expect(response.status).toBe(202);
    await t.backgroundDone();

    expect(await open()).toBe(404);
  });

  test("private to public: a stranger stays a stranger, before Ponzu hears of it and after", async () => {
    const world = await orgWorld("private");
    const stranger = world.people.stranger!;
    const open = async () =>
      (await call(t, stranger.headers, "GET", `/v1/canvases/${world.canvas.id}`)).status;
    expect(await open()).toBe(404);

    // GitHub now answers `read` for anybody, and Ponzu has not heard yet.
    world.main.fake.private = false;
    t.clock.advance(61_000);
    expect(await open()).toBe(404);

    await t.app.request(
      "/v1/github/webhook",
      t.github.delivery("repository", {
        action: "publicized",
        repository: { id: world.main.fake.id },
        installation: { id: world.installation.id },
      }),
    );
    await t.backgroundDone();
    expect(await open()).toBe(404);
  });
});

describe("when the person's own list cannot settle a read", () => {
  /** Lists of repos GitHub cuts short, for the length of `work`. */
  async function cutShort<T>(work: () => Promise<T>): Promise<T> {
    const { github } = t.deps;
    const list = github.listInstallationRepositories;
    github.listInstallationRepositories = async () => ({ items: [], complete: false });
    try {
      return await work();
    } finally {
      github.listInstallationRepositories = list;
    }
  }

  test("made public a moment ago, its token dead: a stranger stays a stranger", async () => {
    const world = await orgWorld("private");
    const stranger = world.people.stranger!;
    const open = async () =>
      (await call(t, stranger.headers, "GET", `/v1/canvases/${world.canvas.id}`)).status;
    expect(await open()).toBe(404);

    // GitHub now answers `read` for anybody; Ponzu still has the repo as private, and the
    // stranger's own list cannot be read to say otherwise.
    world.main.fake.private = false;
    t.github.revokeTokens(stranger.github.id);
    t.clock.advance(61_000);
    expect(await open()).toBe(404);
    expect(
      await getRepoAccess(t.db, { userId: stranger.userId, repoId: world.main.id }),
    ).toMatchObject({ permission: "none" });
  });

  test("made public a moment ago, a list cut short: a stranger stays a stranger", async () => {
    const world = await orgWorld("private");
    const stranger = world.people.stranger!;
    world.main.fake.private = false;
    await cutShort(async () => {
      t.clock.advance(61_000);
      const listed = await call(
        t,
        stranger.headers,
        "GET",
        `/v1/workspaces/${world.workspaceId}/canvases`,
      );
      expect(listed.body.canvases).toEqual([]);
      t.clock.advance(61_000);
      expect(
        (await call(t, stranger.headers, "GET", `/v1/canvases/${world.canvas.id}`)).status,
      ).toBe(404);
    });
  });

  test("still private, its token dead: a read-only collaborator keeps it", async () => {
    const world = await orgWorld("private");
    const reader = world.people.outsideReader!;
    t.github.revokeTokens(reader.github.id);
    t.clock.advance(61_000);
    const opened = await call(t, reader.headers, "GET", `/v1/canvases/${world.canvas.id}`);
    expect(opened.status).toBe(200);
    expect(opened.body.access).toBe("read");
  });

  test("still private, its token dead, GitHub failing: the read kept ten minutes ago stands, and no longer", async () => {
    const world = await orgWorld("private");
    const reader = world.people.outsideReader!;
    const open = () => call(t, reader.headers, "GET", `/v1/canvases/${world.canvas.id}`);
    expect((await open()).body.access).toBe("read");
    t.github.revokeTokens(reader.github.id);

    // Whether the repo is still private cannot be asked: the answer kept stands, as it would if
    // the permission question itself had failed.
    t.clock.advance(2 * 60_000);
    t.github.failNext(`/repositories/${world.main.fake.id}`, 502);
    const during = await open();
    expect(during.status).toBe(200);
    expect(during.body.access).toBe("read");

    // Past ten minutes it does not: GitHub's failure is thrown, as for the permission question.
    // (Asked directly: the test's own Ponzu session would have expired by then.)
    t.clock.advance(9 * 60_000);
    t.github.failNext(`/repositories/${world.main.fake.id}`, 502);
    await expect(
      repoPermission(t.deps, {
        user: {
          id: reader.userId,
          githubUserId: reader.github.id,
          githubLogin: reader.github.login,
        },
        repo: {
          id: world.main.id,
          githubRepoId: world.main.fake.id,
          fullName: world.main.fullName,
        },
        installation: { installationId: world.installation.id, suspendedAt: null },
      }),
    ).rejects.toMatchObject({ name: "UpstreamError" });
  });

  test("a list cut short before a public repo it never reached keeps an organization member's read", async () => {
    // More repos with canvases than a cut-short list asks about one at a time.
    const tag = nextId;
    nextId += 40;
    const people = await signIn(tag, ["owner", "member"]);
    const login = `wide-${tag}`;
    const repositories: FakeRepository[] = Array.from({ length: 22 }, (_, i) => ({
      id: tag + 10 + i,
      fullName: `${login}/r${i}`,
      private: false,
      access: {},
    }));
    const installation: FakeInstallation = {
      id: tag + 1,
      account: {
        id: tag + 2,
        login,
        type: "Organization",
        owners: [people.owner!.github.id],
        members: [people.member!.github.id],
      },
      repositorySelection: "all",
      // And one private repo given them, with no canvas, so the installation is theirs to see.
      repositories: [
        ...repositories,
        {
          id: tag + 5,
          fullName: `${login}/own`,
          private: true,
          access: { [people.member!.github.id]: "write" },
        },
      ],
    };
    t.github.installations.push(installation);
    for (const person of Object.values(people)) await syncGithub(t.deps, person.userId);
    const workspace = (await getWorkspaceByInstallation(t.db, installation.id))!;
    const canvases: Canvas[] = [];
    for (const repository of repositories) {
      const repo = await repoRow(repository.id);
      canvases.push(
        await createCanvas(t.db, {
          workspaceId: workspace.id,
          repoId: repo.id,
          ownerId: people.owner!.userId,
          claudeAccountId: null,
          name: repository.fullName,
          branch: null,
          doc: emptyDoc(repository.fullName),
        }),
      );
    }
    const member = people.member!;
    // The last repo's answer is the newest, so a cut-short list asks about the 21 others first
    // and stops at its limit before this one.
    const last = await repoRow(repositories[21]!.id);
    await recordRepoAccess(t.db, [
      {
        userId: member.userId,
        repoId: last.id,
        permission: "read",
        checkedAt: new Date(t.clock.now() + 1),
      },
    ]);
    await cutShort(async () => {
      t.clock.advance(61_000);
      const opened = await call(t, member.headers, "GET", `/v1/canvases/${canvases[21]!.id}`);
      expect(opened.status).toBe(200);
      expect(opened.body.access).toBe("read");
    });
  });
});

describe("leaving the organization", () => {
  test("a member who leaves loses the public repos they were never given, at their next read", async () => {
    const world = await orgWorld("public");
    const member = world.people.orgMember!;
    const open = async () =>
      (await call(t, member.headers, "GET", `/v1/canvases/${world.canvas.id}`)).status;
    expect(await open()).toBe(200);

    // Removed from the organization, and the webhook that says so is lost.
    world.installation.account.members = world.installation.account.members!.filter(
      (id) => id !== member.github.id,
    );
    t.clock.advance(61_000);
    expect(await open()).toBe(404);
  });
});

describe("answers kept under the old rule", () => {
  test("the migration makes every kept read stale, so none is trusted before GitHub is asked again", async () => {
    const world = await orgWorld("public");
    const stranger = world.people.stranger!;
    const at = new Date(t.clock.now());
    // What the API before this change kept for a stranger on a public repo.
    await recordRepoAccess(t.db, [
      { userId: stranger.userId, repoId: world.main.id, permission: "read", checkedAt: at },
    ]);
    const facts = async () =>
      canvasFactsOf((await notifyCanvasFacts(t.db, { canvasId: world.canvas.id }))!);
    expect(canRead(await facts(), stranger.userId, at)).toBe(true);

    const migration = readFileSync(
      new URL("../../../../packages/db/migrations/0033_public_repo_read.sql", import.meta.url),
      "utf8",
    );
    // As the migrator runs it: its statements in order, in one transaction.
    await pg().query("begin");
    for (const statement of migration.split("--> statement-breakpoint")) {
      await pg().query(statement);
    }
    await pg().query("commit");

    expect(canRead(await facts(), stranger.userId, at)).toBe(false);
    expect((await call(t, stranger.headers, "GET", `/v1/canvases/${world.canvas.id}`)).status).toBe(
      404,
    );
    expect(
      await getRepoAccess(t.db, { userId: stranger.userId, repoId: world.main.id }),
    ).toMatchObject({ permission: "none" });
    // A reader's own answer is asked again too, and comes back.
    const reader = world.people.outsideReader!;
    expect(
      (await call(t, reader.headers, "GET", `/v1/canvases/${world.canvas.id}`)).body.access,
    ).toBe("read");
  });
});
