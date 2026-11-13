// Nobody can find what they may not see: search answers only from the canvases the canvas list
// would show the same person (`readableCanvases`), in every group, as access changes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyDoc, searchTerms } from "@ponzu/core";
import { inArray } from "drizzle-orm";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { memberships, type RepoPermission, repoAccess } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { upsertMembership, upsertRepos } from "./accounts.ts";
import { createCanvas, listWorkspaceCanvases } from "./canvases.ts";
import { removeMembership } from "./members.ts";
import { recordPullRequestRead } from "./pull-requests.ts";
import { recordNoRepoAccess, recordRepoAccess } from "./repo-access.ts";
import {
  SEARCH_GROUP_CAPS,
  SEARCH_GROUPS,
  type SearchGroup,
  type SearchHits,
  searchCanvases,
  upsertSearchEntries,
} from "./search.ts";
import { appendThreadItem, postMessage } from "./thread.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const ZEBRA = searchTerms("zebra");

/** A canvas, and the rare word in everything search could find on it, and in an aside. */
async function zebraCanvas({
  workspaceId,
  repoId,
  ownerId,
  label,
  number,
}: {
  workspaceId: string;
  repoId: string | null;
  ownerId: string;
  label: string;
  number: number;
}) {
  const canvas = await createCanvas(db, {
    workspaceId,
    repoId,
    ownerId,
    claudeAccountId: null,
    name: `Zebra ${label}`,
    branch: repoId ? `pz/zebra-${label}` : null,
    doc: emptyDoc(`Zebra ${label}`),
  });
  const message = await postMessage(db, {
    canvasId: canvas.id,
    userId: ownerId,
    item: { text: `A zebra message on ${label}` },
    event: { text: `A zebra message on ${label}` },
    search: {
      text: `A zebra message on ${label}`,
      author: { kind: "user", id: ownerId, name: "Owner" },
    },
  });
  const answer = await appendThreadItem(db, {
    canvasId: canvas.id,
    kind: "assistant",
    payload: { text: "The zebra answer" },
  });
  const aside = await appendThreadItem(db, {
    canvasId: canvas.id,
    kind: "assistant",
    payload: { text: "A zebra aside" },
  });
  await upsertSearchEntries(db, {
    canvasId: canvas.id,
    entries: [
      {
        kind: "page",
        ref: "pg_1",
        text: "Zebra page",
        context: { kind: "page" },
        author: null,
        at: null,
      },
      {
        kind: "board",
        ref: "ab_1",
        text: "Zebra board",
        context: { kind: "board", pageId: "pg_1" },
        author: null,
        at: null,
      },
      {
        kind: "comment",
        ref: "th_1/m_1",
        text: "Is the zebra too loud?",
        context: {
          kind: "comment",
          threadId: "th_1",
          messageId: "m_1",
          pageId: "pg_1",
          artboardId: "ab_1",
          resolved: false,
        },
        author: { kind: "user", id: ownerId, name: "Owner" },
        at: 1_000,
      },
      {
        kind: "message",
        ref: answer.id,
        text: "The zebra answer",
        context: { kind: "message", itemSeq: answer.seq },
        author: { kind: "agent", id: null, name: "Ponzu" },
        at: 2_000,
      },
    ],
  });
  await recordPullRequestRead(db, {
    canvasId: canvas.id,
    number,
    title: `Zebra stripes for ${label}`,
    state: "open",
    checks: "running",
    mergeable: null,
    autoMerge: false,
    updatedAt: new Date(),
    readAt: new Date(),
  });
  return { canvas, message, aside };
}

/** For each group, the ids of the canvases it found, sorted. */
function canvasIds(hits: SearchHits): Record<SearchGroup, string[]> {
  return Object.fromEntries(
    SEARCH_GROUPS.map((group) => [group, [...new Set(hits[group].map((h) => h.canvasId))].sort()]),
  ) as Record<SearchGroup, string[]>;
}

const everyGroup = (ids: string[]) =>
  Object.fromEntries(SEARCH_GROUPS.map((group) => [group, [...ids].sort()]));

const search = (workspaceId: string, userId: string) =>
  searchCanvases(db, { workspaceId, userId, terms: ZEBRA });
const listed = async (workspaceId: string, userId: string) =>
  (await listWorkspaceCanvases(db, { workspaceId, userId })).map((canvas) => canvas.id).sort();

let numbers = 1;

/**
 * The searcher U and another person O. W1, an org U belongs to, with repos U may read, write,
 * not read, and was never asked about, a canvas in each, and a Scratch canvas each. W2, which U
 * is not a member of, though a leftover answer says U is an admin of its repo.
 */
async function world() {
  const [u, o, w1, w2] = await Promise.all([
    seedUser(db, "ursula"),
    seedUser(db, "oscar"),
    seedWorkspace(db, "acme"),
    seedWorkspace(db, "elsewhere"),
  ]);
  const [rRead, rWrite, rNone, rUnasked, r2] = await Promise.all([
    seedRepo(db, w1.id, `acme/read-${numbers}`),
    seedRepo(db, w1.id, `acme/write-${numbers}`),
    seedRepo(db, w1.id, `acme/none-${numbers}`),
    seedRepo(db, w1.id, `acme/unasked-${numbers}`),
    seedRepo(db, w2.id, `elsewhere/app-${numbers}`),
  ]);
  await upsertMembership(db, { workspaceId: w1.id, userId: u.id, role: "member" });
  await upsertMembership(db, { workspaceId: w1.id, userId: o.id, role: "admin" });
  await upsertMembership(db, { workspaceId: w2.id, userId: o.id, role: "admin" });
  const checkedAt = new Date("2026-11-10T12:00:00Z");
  await recordRepoAccess(db, [
    { userId: u.id, repoId: rRead.id, permission: "read", checkedAt },
    { userId: u.id, repoId: rWrite.id, permission: "write", checkedAt },
    { userId: u.id, repoId: rNone.id, permission: "none", checkedAt },
    { userId: u.id, repoId: r2.id, permission: "admin", checkedAt },
    ...[rRead, rWrite, rNone, rUnasked, r2].map((repo) => ({
      userId: o.id,
      repoId: repo.id,
      permission: "admin" as const,
      checkedAt,
    })),
  ]);
  const make = (workspaceId: string, repoId: string | null, ownerId: string, label: string) =>
    zebraCanvas({ workspaceId, repoId, ownerId, label, number: numbers++ });
  const read = await make(w1.id, rRead.id, o.id, "read");
  const write = await make(w1.id, rWrite.id, o.id, "write");
  const none = await make(w1.id, rNone.id, o.id, "none");
  const unasked = await make(w1.id, rUnasked.id, o.id, "unasked");
  const scratchU = await make(w1.id, null, u.id, "scratch-u");
  const scratchO = await make(w1.id, null, o.id, "scratch-o");
  const inW2 = await make(w2.id, r2.id, o.id, "w2");
  return {
    u,
    o,
    w1,
    w2,
    repos: { rRead, rWrite, rNone, rUnasked, r2 },
    canvases: { read, write, none, unasked, scratchU, scratchO, inW2 },
    later: new Date("2026-11-11T12:00:00Z"),
  };
}

describe("search finds only what the canvas list shows", () => {
  test("a member finds, in every group, the canvases of repos they can read and their own Scratch", async () => {
    const { u, w1, canvases } = await world();
    const expected = [canvases.read, canvases.write, canvases.scratchU].map((c) => c.canvas.id);

    const hits = await search(w1.id, u.id);

    expect(canvasIds(hits)).toEqual(everyGroup(expected) as Record<SearchGroup, string[]>);
    expect(await listed(w1.id, u.id)).toEqual([...expected].sort());
    // Each canvas is found once per kind: its name, page, board, comment, message, answer and
    // pull request. Never an aside, which nothing indexes.
    const asides = new Set(Object.values(canvases).map((c) => c.aside.id));
    const all = SEARCH_GROUPS.flatMap((group) => hits[group]);
    expect(all.some((hit) => asides.has(hit.ref))).toBe(false);
    expect(hits.messages.map((hit) => hit.text).sort()).toEqual(
      [
        "A zebra message on read",
        "A zebra message on scratch-u",
        "A zebra message on write",
        "The zebra answer",
        "The zebra answer",
        "The zebra answer",
      ].sort(),
    );
    expect(hits.boards.map((hit) => hit.kind).sort()).toEqual([
      "board",
      "board",
      "board",
      "page",
      "page",
      "page",
    ]);
  });

  test("a leftover repo answer in a workspace they are not a member of finds nothing", async () => {
    const { u, w2 } = await world();
    expect(canvasIds(await search(w2.id, u.id))).toEqual(
      everyGroup([]) as Record<SearchGroup, string[]>,
    );
    expect(await listed(w2.id, u.id)).toEqual([]);
  });

  test("a newer answer that a repo is no longer readable takes its hits away", async () => {
    const { u, w1, repos, canvases, later } = await world();
    await recordRepoAccess(db, [
      { userId: u.id, repoId: repos.rRead.id, permission: "none", checkedAt: later },
    ]);
    const expected = [canvases.write, canvases.scratchU].map((c) => c.canvas.id);
    expect(canvasIds(await search(w1.id, u.id))).toEqual(
      everyGroup(expected) as Record<SearchGroup, string[]>,
    );
    expect(await listed(w1.id, u.id)).toEqual([...expected].sort());
  });

  test("after leaving the workspace, nothing, not even their own Scratch", async () => {
    const { u, w1 } = await world();
    expect(await removeMembership(db, { installationId: w1.installationId!, userId: u.id })).toBe(
      w1.id,
    );
    expect(canvasIds(await search(w1.id, u.id))).toEqual(
      everyGroup([]) as Record<SearchGroup, string[]>,
    );
    expect(await listed(w1.id, u.id)).toEqual([]);
  });

  test("an uninstalled or suspended workspace leaves only their own Scratch", async () => {
    const { u, w1, canvases, later } = await world();
    await recordNoRepoAccess(db, { workspaceId: w1.id, userId: u.id, checkedAt: later });
    const expected = [canvases.scratchU.canvas.id];
    expect(canvasIds(await search(w1.id, u.id))).toEqual(
      everyGroup(expected) as Record<SearchGroup, string[]>,
    );
    expect(await listed(w1.id, u.id)).toEqual(expected);
  });

  test("a transferred repo's hits leave with it, and show in the new workspace only to who can read it", async () => {
    const { u, o, w1, w2, repos, canvases } = await world();
    const reader = await seedUser(db, "rhea");
    const blind = await seedUser(db, "bo");
    for (const person of [u, reader, blind]) {
      await upsertMembership(db, { workspaceId: w2.id, userId: person.id, role: "member" });
    }
    await recordRepoAccess(db, [
      {
        userId: reader.id,
        repoId: repos.rRead.id,
        permission: "read",
        checkedAt: new Date("2026-11-10T12:00:00Z"),
      },
    ]);

    await upsertRepos(db, {
      workspaceId: w2.id,
      repos: [
        {
          githubRepoId: repos.rRead.githubRepoId,
          fullName: `elsewhere/moved-${repos.rRead.id}`,
          defaultBranch: "main",
          private: true,
          pushedAt: null,
        },
      ],
    });

    const moved = canvases.read.canvas.id;
    const inW1 = [canvases.write, canvases.scratchU].map((c) => c.canvas.id);
    expect(canvasIds(await search(w1.id, u.id))).toEqual(
      everyGroup(inW1) as Record<SearchGroup, string[]>,
    );
    // U's old answer for the repo still says read, and U is now a member of W2.
    expect(canvasIds(await search(w2.id, u.id))).toEqual(
      everyGroup([moved, canvases.inW2.canvas.id]) as Record<SearchGroup, string[]>,
    );
    expect(canvasIds(await search(w2.id, reader.id))).toEqual(
      everyGroup([moved]) as Record<SearchGroup, string[]>,
    );
    expect(canvasIds(await search(w2.id, blind.id))).toEqual(
      everyGroup([]) as Record<SearchGroup, string[]>,
    );
    expect(canvasIds(await search(w2.id, o.id)).canvases).toContain(moved);
    for (const [workspaceId, userId] of [
      [w1.id, u.id],
      [w2.id, u.id],
      [w2.id, reader.id],
      [w2.id, blind.id],
    ] as const) {
      expect(await listed(workspaceId, userId)).toEqual(
        canvasIds(await search(workspaceId, userId)).canvases,
      );
    }
  });
});

/** A small seeded generator (mulberry32), so a failure is the same every run. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("search never shows a canvas the list would not", () => {
  test("200 random access matrices: the list is what the rules say, and every group's canvases are the list's, up to its cap", async () => {
    const next = random(20261112);
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    const people = await Promise.all(["pia", "quinn", "ravi"].map((login) => seedUser(db, login)));
    const spaces = await Promise.all(["one", "two"].map((login) => seedWorkspace(db, login)));
    const repos = await Promise.all(
      ["a", "b", "c"].map((name, i) => seedRepo(db, spaces[i % 2]!.id, `m/${name}-${numbers}`)),
    );
    // Every canvas made, as the test itself understands it, for an oracle that shares no code
    // with readableCanvases.
    const made: {
      id: string;
      repo: (typeof repos)[number] | null;
      ownerId: string;
      workspaceId: string;
    }[] = [];
    for (const repo of repos) {
      const { canvas } = await zebraCanvas({
        workspaceId: repo.workspaceId,
        repoId: repo.id,
        ownerId: people[0]!.id,
        label: repo.fullName,
        number: numbers++,
      });
      made.push({ id: canvas.id, repo, ownerId: people[0]!.id, workspaceId: repo.workspaceId });
    }
    for (const person of people) {
      for (const space of spaces) {
        const { canvas } = await zebraCanvas({
          workspaceId: space.id,
          repoId: null,
          ownerId: person.id,
          label: `${person.githubLogin}-${space.githubLogin}`,
          number: numbers++,
        });
        made.push({ id: canvas.id, repo: null, ownerId: person.id, workspaceId: space.id });
      }
    }
    const userIds = people.map((p) => p.id);
    const permissions: (RepoPermission | null)[] = ["admin", "write", "read", "none", null];

    for (let round = 0; round < 200; round++) {
      await db.delete(memberships).where(inArray(memberships.userId, userIds));
      await db.delete(repoAccess).where(inArray(repoAccess.userId, userIds));
      const joined = people.flatMap((person) =>
        spaces
          .filter(() => next() < 0.7)
          .map((space) => ({ workspaceId: space.id, userId: person.id, role: "member" as const })),
      );
      if (joined.length) await db.insert(memberships).values(joined);
      const answers = people.flatMap((person) =>
        repos.flatMap((repo) => {
          const permission = pick(permissions);
          return permission === null
            ? []
            : [{ userId: person.id, repoId: repo.id, permission, checkedAt: new Date() }];
        }),
      );
      if (answers.length) await db.insert(repoAccess).values(answers);
      // Now and then a repo moves to the other workspace, and its canvas with it.
      if (next() < 0.2) {
        const repo = pick(repos);
        const to = spaces.find((space) => space.id !== repo.workspaceId)!;
        await upsertRepos(db, {
          workspaceId: to.id,
          repos: [
            {
              githubRepoId: repo.githubRepoId,
              fullName: repo.fullName,
              defaultBranch: "main",
              private: true,
              pushedAt: null,
            },
          ],
        });
        repo.workspaceId = to.id;
      }

      const member = new Set(joined.map((m) => `${m.workspaceId}:${m.userId}`));
      const readable = new Set(
        answers.filter((a) => a.permission !== "none").map((a) => `${a.repoId}:${a.userId}`),
      );
      for (const person of people) {
        for (const space of spaces) {
          const list = await listed(space.id, person.id);
          const expected = made
            .filter((canvas) =>
              canvas.repo
                ? canvas.repo.workspaceId === space.id &&
                  readable.has(`${canvas.repo.id}:${person.id}`)
                : canvas.workspaceId === space.id && canvas.ownerId === person.id,
            )
            .filter(() => member.has(`${space.id}:${person.id}`))
            .map((canvas) => canvas.id)
            .sort();
          expect(list).toEqual(expected);
          const hits = await search(space.id, person.id);
          const found = canvasIds(hits);
          for (const group of SEARCH_GROUPS) {
            for (const id of found[group]) expect(list).toContain(id);
            // Every listed canvas has the same hits in every group (two in Boards, a page and a
            // board, and two in Messages, a message and an answer), so up to the cap they are
            // equal.
            const each = group === "boards" || group === "messages" ? 2 : 1;
            if (list.length * each <= SEARCH_GROUP_CAPS[group]) expect(found[group]).toEqual(list);
            else expect(hits[group]).toHaveLength(SEARCH_GROUP_CAPS[group]);
          }
        }
      }
    }
  }, 300_000);
});
