// What PGlite cannot show, on a real Postgres: statements that truly run at once, and a planner
// working from the statistics of a table that was empty a moment ago. Runs only when
// PONZU_TEST_DATABASE_URL names a migrated database (see ../live.ts); CI gives it a Postgres 18.
import { afterAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { actorFor, rename, seedDesign, seedUser, seedWorkspace } from "../fixtures.ts";
import { newId } from "../ids.ts";
import { describeLive } from "../live.ts";
import { designOps, events, jobs, memberships } from "../schema/index.ts";
import { upsertMembership } from "./accounts.ts";
import { getDesign, getDesignHead } from "./designs.ts";
import { appendEvent, claimEvents } from "./events.ts";
import { claimGithubTokenRefresh, saveGithubUserToken } from "./github-tokens.ts";
import { claimJobs, enqueueJob } from "./jobs.ts";
import { ensureWorkspaceAdmin, setMemberRole, workspaceHasAdmin } from "./members.ts";
import { commitOps, readOps } from "./ops.ts";
import { answerQuestion, countOpenQuestions, createQuestion } from "./questions.ts";
import { takeRunnerLease } from "./runners.ts";
import { commitReversal } from "./undo.ts";

const times = <T>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

describeLive("races on a real Postgres", ({ db, close }) => {
  afterAll(close);

  test("of committers racing on one seq exactly one wins, and the log has no gaps", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    const rounds = 10;

    for (let round = 0; round < rounds; round++) {
      const results = await Promise.all(
        times(8, (racer) =>
          commitOps(db, {
            designId: design.id,
            expectedSeq: round * 2,
            actor,
            ops: [rename(`${round}-${racer}-1`, "A"), rename(`${round}-${racer}-2`, "B")],
          }),
        ),
      );
      expect(results.filter((result) => result.kind === "committed")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "conflict")).toHaveLength(7);
    }

    expect((await getDesign(db, design.id))!.seq).toBe(rounds * 2);
    const log = await readOps(db, { designId: design.id, after: 0 });
    if (log?.kind !== "ok") throw new Error("expected ops");
    expect(log.ops.map((op) => op.seq)).toEqual(times(rounds * 2, (i) => i + 1));
  }, 60_000);

  test("one op posted many times at once is stored once and never fails", async () => {
    const { design, user } = await seedDesign(db);
    const post = () =>
      commitOps(db, {
        designId: design.id,
        expectedSeq: 0,
        actor: actorFor(user),
        ops: [rename("same", "Same")],
      });

    const results = await Promise.all(times(6, post));

    // Whoever lost the design's row waited, saw the seq had moved and got a conflict; whoever
    // started after the winner finished was handed the stored op. Nobody appended it again.
    const committed = results.filter((result) => result.kind === "committed");
    expect(committed.filter((result) => result.replayed.length === 0)).toHaveLength(1);
    for (const result of results) expect(["committed", "conflict"]).toContain(result.kind);
    expect(await db.$count(designOps, eq(designOps.designId, design.id))).toBe(1);
    expect(await post()).toMatchObject({ kind: "committed", seq: 1, replayed: ["same"] });
  }, 60_000);

  test("many undos of one op at once: one lands and the op is taken back once", async () => {
    const { design, user } = await seedDesign(db);
    const actor = actorFor(user);
    await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor,
      ops: [rename("a", "One")],
    });

    const results = await Promise.all(
      times(6, (racer) =>
        commitReversal(db, {
          designId: design.id,
          expectedSeq: 1,
          actor,
          kind: "undo",
          reverses: 1,
          op: rename(`undo-${racer}`, "Lisbon", "One"),
        }),
      ),
    );

    expect(results.filter((result) => result.kind === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "conflict")).toHaveLength(5);
    const log = await readOps(db, { designId: design.id, after: 0 });
    if (log?.kind !== "ok") throw new Error("expected ops");
    expect(log.ops.map((op) => [op.seq, op.kind, op.reversedBy])).toEqual([
      [1, "do", 2],
      [2, "undo", null],
    ]);
  }, 60_000);

  test("callers claiming one token's refresh at once: exactly one holds it", async () => {
    const user = await seedUser(db);
    const now = new Date();
    await saveGithubUserToken(db, {
      userId: user.id,
      encryptedAccessToken: "access",
      accessTokenExpiresAt: now,
      encryptedRefreshToken: "refresh",
      refreshTokenExpiresAt: null,
    });

    const claims = await Promise.all(
      times(8, () =>
        claimGithubTokenRefresh(db, {
          userId: user.id,
          now,
          staleAt: new Date(now.getTime() + 300_000),
          until: new Date(now.getTime() + 30_000),
        }),
      ),
    );

    expect(claims.filter((claimed) => claimed !== null)).toHaveLength(1);
  }, 60_000);

  test("a claim of jobs keeps to its limit when the table was empty a moment ago", async () => {
    // The statistics say the table is empty, which is when the planner joins by nested loop.
    await db.delete(jobs);
    await db.execute(sql`analyze jobs`);
    for (const index of times(12, (i) => i)) await enqueueJob(db, { kind: `live-${index}` });

    expect(await claimJobs(db, { worker: "w1", limit: 2 })).toHaveLength(2);
    expect(await claimJobs(db, { worker: "w2", limit: 1 })).toHaveLength(1);
    expect(await db.$count(jobs, sql`${jobs.lockedBy} is not null`)).toBe(3);
  }, 60_000);

  test("workers claiming at once take different jobs, each within its limit", async () => {
    await db.delete(jobs);
    await db.execute(sql`analyze jobs`);
    await db.insert(jobs).values(times(40, (i) => ({ id: `job_live_${i}`, kind: "live" })));

    const claims = await Promise.all(
      times(10, (worker) => claimJobs(db, { worker: `w${worker}`, limit: 5 })),
    );

    for (const claimed of claims) expect(claimed.length).toBeLessThanOrEqual(5);
    const taken = claims.flat().map((job) => job.id);
    expect(new Set(taken).size).toBe(taken.length);
    // A worker passes over what another has locked, so a few may be left for the next sweep.
    const rest = await claimJobs(db, { worker: "sweep", limit: 40 });
    expect(taken.length + rest.length).toBe(40);
    expect(await db.$count(jobs, eq(jobs.attempts, 1))).toBe(40);
    await db.delete(jobs);
  }, 60_000);

  test("a claim of events keeps to its limit, and claims at once never share an event", async () => {
    const { design } = await seedDesign(db);
    await db.execute(sql`analyze events`);
    for (const index of times(13, (i) => i)) {
      await appendEvent(db, {
        designId: design.id,
        kind: "message",
        priority: "now",
        payload: { index },
      });
    }

    const { runnerId } = await takeRunnerLease(db, { designId: design.id, now: new Date() });
    const claim = async (limit?: number) =>
      (await claimEvents(db, { designId: design.id, runnerId, claimId: newId("clm"), limit }))!
        .events;

    const first = await claim(2);
    expect(first.map((event) => event.payload)).toEqual([{ index: 0 }, { index: 1 }]);

    const claims = await Promise.all(times(6, () => claim(3)));
    for (const claimed of claims) expect(claimed.length).toBeLessThanOrEqual(3);
    const taken = claims.flat().map((event) => event.id);
    expect(new Set(taken).size).toBe(taken.length);
    const rest = await claim();
    expect(first.length + taken.length + rest.length).toBe(13);
    await db.delete(events).where(eq(events.designId, design.id));
  }, 60_000);

  test("admins demoting one another at once never leave a workspace without one", async () => {
    for (let round = 0; round < 5; round++) {
      const [workspace, ...admins] = await Promise.all([
        seedWorkspace(db),
        seedUser(db, "a"),
        seedUser(db, "b"),
        seedUser(db, "c"),
      ]);
      for (const admin of admins) {
        await upsertMembership(db, { workspaceId: workspace.id, userId: admin.id, role: "admin" });
      }

      const results = await Promise.all(
        admins.map((admin) =>
          setMemberRole(db, { workspaceId: workspace.id, userId: admin.id, role: "member" }),
        ),
      );

      expect(results.filter((result) => result === "updated")).toHaveLength(2);
      expect(results.filter((result) => result === "last_admin")).toHaveLength(1);
      expect(await workspaceHasAdmin(db, workspace.id)).toBe(true);
    }
  }, 60_000);

  test("people joining a workspace with no admin at once leave it with one", async () => {
    for (let round = 0; round < 5; round++) {
      const [workspace, ...people] = await Promise.all([
        seedWorkspace(db),
        seedUser(db, "a"),
        seedUser(db, "b"),
        seedUser(db, "c"),
      ]);

      // What each one's sync does: join, then see that the workspace has an admin.
      await Promise.all(
        people.map(async (person) => {
          await upsertMembership(db, {
            workspaceId: workspace.id,
            userId: person.id,
            role: "member",
            githubAccess: "member",
          });
          await ensureWorkspaceAdmin(db, workspace.id);
        }),
      );
      // Whoever was too early to see the others is put right by the next sync.
      await ensureWorkspaceAdmin(db, workspace.id);

      const admins = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspace.id), eq(memberships.role, "admin")));
      expect(admins.length).toBeGreaterThanOrEqual(1);
    }
  }, 60_000);

  test("many answers to one question at once: the first wins and the count drops once", async () => {
    const { design, user } = await seedDesign(db);
    const question = await createQuestion(db, {
      designId: design.id,
      kind: "question",
      payload: {},
    });
    await createQuestion(db, { designId: design.id, kind: "question", payload: {} });

    const results = await Promise.all(
      times(6, (choice) =>
        answerQuestion(db, {
          designId: design.id,
          id: question.id,
          answer: { choice },
          userId: user.id,
        }),
      ),
    );

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect((await getDesignHead(db, design.id))!.needsYouCount).toBe(1);
    expect(await countOpenQuestions(db, design.id)).toBe(1);
    const told = await db
      .select()
      .from(events)
      .where(and(eq(events.designId, design.id), eq(events.kind, "answer")));
    expect(told).toHaveLength(1);
  }, 60_000);

  test("one question raised many times at once is one question, counted once", async () => {
    const { design } = await seedDesign(db);
    const id = newId("q");

    const raised = await Promise.all(
      times(6, () => createQuestion(db, { designId: design.id, id, kind: "plan", payload: {} })),
    );

    expect(raised.filter((result) => result.raised)).toHaveLength(1);
    expect(raised.every((result) => result.status === "open")).toBe(true);
    expect((await getDesignHead(db, design.id))!.needsYouCount).toBe(1);
  }, 60_000);
});
