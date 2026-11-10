// Drivers disagree about json parameters, about what a raw statement hands back, and about
// bigints and times. Every test in this package runs on PGlite; this file runs each kind of
// statement once through the drivers that reach a real Postgres and checks what comes back is
// what PGlite gave. Runs only when PONZU_TEST_DATABASE_URL is set (see ../live.ts).
import { afterAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { actorFor, rename, seedDesign, seedRepo, seedUser } from "../fixtures.ts";
import { describeLive } from "../live.ts";
import {
  deleteMembershipsExcept,
  getRepoInstallationId,
  getUserByWorkosId,
  listStaleInstallations,
  listWorkspaceRepos,
  markReposRemovedExcept,
  markWorkspaceUninstalled,
  upsertMembership,
  wasUninstalled,
} from "./accounts.ts";
import { consumeAuthState, createAuthState } from "./auth-states.ts";
import { readDocSource, writeCheckpoint } from "./checkpoints.ts";
import {
  createDesign,
  getDesignAssetKey,
  getDesignHead,
  listWorkspaceDesigns,
  markDesignSeen,
} from "./designs.ts";
import { appendEvent, claimEvents, markEventsDelivered } from "./events.ts";
import {
  claimGithubTokenRefresh,
  getGithubUserToken,
  releaseGithubTokenRefresh,
  saveGithubUserToken,
} from "./github-tokens.ts";
import {
  countWorkspaceMembers,
  ensureWorkspaceAdmin,
  listWorkspaceMembers,
  removeMembership,
  setMemberRepos,
  setMemberRole,
} from "./members.ts";
import { commitOps, findOps, readOps } from "./ops.ts";
import { pingDb } from "./ping.ts";
import { listPresence, touchPresence } from "./presence.ts";
import { findDesignByBranch, recordPullRequest } from "./pull-requests.ts";
import { answerSecretQuestion, cancelQuestions, createQuestion } from "./questions.ts";
import { listDesignRepoAccess, recordRepoAccess } from "./repo-access.ts";
import { QueryError } from "./run.ts";
import { createRunnerToken, verifyRunnerToken } from "./runner-tokens.ts";
import { admitSession, endSession, getSessionUser } from "./sessions.ts";
import { appendThreadItem, listThreadItems, updateThreadItem } from "./thread.ts";
import { commitReversal, nextRedo, nextUndo } from "./undo.ts";
import { addLedgerEntry, ledgerBalance, recordUsage } from "./usage.ts";
import { takeWebhookDelivery } from "./webhooks.ts";

describeLive("queries on a real Postgres", ({ db, close }) => {
  afterAll(close);

  test("ops, checkpoints and undo keep their json, their order and their types", async () => {
    const { design, user } = await seedDesign(db);
    const actor = { ...actorFor(user), avatarUrl: "https://example.com/a.png" };
    const style = { "margin-top": "4px", margin: "0", color: "red", a: "1" };

    const committed = await commitOps(db, {
      designId: design.id,
      expectedSeq: 0,
      actor,
      ops: [
        rename("a", "One 😀"),
        {
          id: "b",
          op: { op: "style", id: "n_1", style },
          inverse: { op: "style", id: "n_1", style: {} },
        },
      ],
      events: [
        { opId: "a", kind: "edit", priority: "later", payload: { summary: "x" }, userId: user.id },
      ],
      head: { name: "One 😀", icon: null },
    });

    if (committed.kind !== "committed") throw new Error("expected a commit");
    const [event] = await claimEvents(db, { designId: design.id });
    expect(event).toMatchObject({ kind: "edit", payload: { summary: "x", seq: 1 } });
    expect((await getDesignHead(db, design.id))!.name).toBe("One 😀");
    expect(committed).toMatchObject({ seq: 2, replayed: [] });
    expect(committed.ops[0]).toMatchObject({ seq: 1, id: "a", op: { name: "One 😀" }, actor });
    expect(committed.ops[0]!.at).toBeInstanceOf(Date);
    const read = await readOps(db, { designId: design.id, after: 0 });
    if (read?.kind !== "ok") throw new Error("expected ops");
    expect(read.ops).toEqual(committed.ops);
    const stored = read.ops[1]!.op;
    if (stored.op !== "style") throw new Error("wrong op");
    expect(Object.keys(stored.style)).toEqual(Object.keys(style));
    expect(await findOps(db, { designId: design.id, ids: ["b", "nope"] })).toEqual([
      committed.ops[1]!,
    ]);
    expect(
      await commitOps(db, {
        designId: design.id,
        expectedSeq: 0,
        actor,
        ops: [rename("a", "x")],
      }),
    ).toEqual({
      kind: "committed",
      seq: 2,
      ops: [committed.ops[0]!],
      replayed: ["a"],
    });
    expect(
      await commitOps(db, {
        designId: design.id,
        expectedSeq: 2,
        actor,
        ops: [rename("nul", "\u0000")],
      }),
    ).toEqual({ kind: "unstorable", ids: ["nul"] });

    const doc = emptyDoc("ordered");
    doc.notes = { zebra: "1", apple: "2" };
    expect(await writeCheckpoint(db, { designId: design.id, seq: 2, doc })).toEqual({
      written: true,
      prunedOps: 0,
    });
    const source = await readDocSource(db, design.id);
    expect(source).toEqual({ seq: 2, checkpoint: { seq: 2, doc }, ops: [] });
    expect(Object.keys(source!.checkpoint.doc.notes)).toEqual(["zebra", "apple"]);

    const target = await nextUndo(db, { designId: design.id, actorId: user.id });
    expect(target).toMatchObject({ seq: 2, id: "b" });
    const undone = await commitReversal(db, {
      designId: design.id,
      expectedSeq: 2,
      actor,
      kind: "undo",
      reverses: 2,
      op: { id: "undo-b", op: target!.inverse, inverse: target!.op },
    });
    expect(undone).toMatchObject({
      kind: "committed",
      seq: 3,
      ops: [{ kind: "undo", reverses: 2 }],
    });
    expect(await nextRedo(db, { designId: design.id, actorId: user.id })).toMatchObject({
      seq: 3,
    });
  }, 60_000);

  test("designs, their head and their list come back with numbers and dates", async () => {
    const { design, user, workspace } = await seedDesign(db);
    const repo = await seedRepo(db, workspace.id, `north-brook/live-${design.id}`);
    const inRepo = await createDesign(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "checkout",
      branch: `pz/checkout-${design.id}`,
      doc: emptyDoc("checkout"),
    });
    await markDesignSeen(db, { userId: user.id, designId: inRepo.id, seq: 4, threadSeq: 9 });
    const checkedAt = new Date("2026-11-10T12:00:00.123Z");
    await recordRepoAccess(db, [
      { userId: user.id, repoId: repo.id, permission: "read", checkedAt },
    ]);
    expect(
      await listDesignRepoAccess(db, { workspaceId: workspace.id, userId: user.id }),
    ).toContainEqual({
      repoId: repo.id,
      githubRepoId: repo.githubRepoId,
      permission: "read",
      checkedAt,
    });

    const head = await getDesignHead(db, inRepo.id);
    expect(head).toMatchObject({
      seq: 0,
      previewSeq: null,
      agentArtboards: [],
      needsYouCount: 0,
    });
    expect(head!.lastActivityAt).toBeInstanceOf(Date);
    expect(await getDesignAssetKey(db, inRepo.id)).toMatch(/^[0-9a-z]{32}$/);
    const list = await listWorkspaceDesigns(db, { workspaceId: workspace.id, userId: user.id });
    expect(list.find((row) => row.id === inRepo.id)).toMatchObject({
      ...head!,
      repoFullName: repo.fullName,
      // Nothing past what there is: the design is at 0 and has no thread.
      seenSeq: 0,
      seenThreadSeq: 0,
    });
  }, 60_000);

  test("the thread, events, questions and presence keep their payloads", async () => {
    const { design, user, workspace } = await seedDesign(db);
    const payload = { text: "hello", nested: { list: [1, "two", null] } };

    const item = await appendThreadItem(db, {
      designId: design.id,
      kind: "assistant",
      payload: { text: "cut \ud83d" },
      streaming: true,
    });
    expect(item).toMatchObject({ payload: { text: "cut \ufffd" }, streaming: true });
    expect(typeof item!.seq).toBe("number");
    await updateThreadItem(db, { designId: design.id, id: item!.id, payload, streaming: false });
    expect(await listThreadItems(db, { designId: design.id })).toMatchObject([{ payload }]);

    await appendEvent(db, { designId: design.id, kind: "message", priority: "now", payload });
    const claimed = await claimEvents(db, { designId: design.id });
    expect(claimed).toMatchObject([{ payload, deliveredAt: null }]);
    expect(claimed[0]!.claimedAt).toBeInstanceOf(Date);
    expect(
      await markEventsDelivered(db, {
        designId: design.id,
        ids: claimed.map((event) => event.id),
      }),
    ).toBe(1);

    const repo = await seedRepo(db, workspace.id, `north-brook/live-${design.id}`);
    const inRepo = await createDesign(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "secrets",
      branch: `pz/secrets-${design.id}`,
      doc: emptyDoc("secrets"),
    });
    const question = await createQuestion(db, { designId: inRepo.id, kind: "secret", payload });
    await createQuestion(db, { designId: inRepo.id, kind: "question", payload });
    const answered = await answerSecretQuestion(db, {
      designId: inRepo.id,
      id: question.id,
      name: "API_KEY",
      encryptedValue: "v1.ciphertext",
      userId: user.id,
    });
    expect(answered).toMatchObject({ status: "answered", answer: { name: "API_KEY" }, payload });
    expect(await cancelQuestions(db, { designId: inRepo.id })).toBe(1);
    expect((await getDesignHead(db, inRepo.id))!.needsYouCount).toBe(0);

    const now = new Date();
    await touchPresence(db, { designId: design.id, userId: user.id, pageId: "pg_1", now });
    await touchPresence(db, { designId: design.id, userId: user.id, now });
    const [here] = await listPresence(db, { designId: design.id, now });
    expect(here).toMatchObject({ userId: user.id, pageId: "pg_1" });
    expect(here!.joinedAt).toBeInstanceOf(Date);
  }, 60_000);

  test("runner tokens and the ledger", async () => {
    const { design, user, workspace } = await seedDesign(db);

    const { token, expiresAt } = await createRunnerToken(db, {
      designId: design.id,
      ttlSeconds: 600,
    });
    expect(expiresAt).toBeInstanceOf(Date);
    expect(await verifyRunnerToken(db, token)).toMatchObject({ designId: design.id });

    const periodStart = new Date(Date.UTC(2020, 0, 1) + Math.floor(Math.random() * 1e9) * 1000);
    await addLedgerEntry(db, {
      workspaceId: workspace.id,
      delta: 100,
      reason: "grant",
      periodStart,
      userId: user.id,
    });
    const usage = {
      id: `use_live_${design.id}`,
      workspaceId: workspace.id,
      designId: design.id,
      userId: user.id,
      kind: "sandbox" as const,
      seconds: 1800,
      credits: 2.5,
      costMicrousd: 9000,
      payer: "ponzu" as const,
      rateCardVersion: 1,
      occurredAt: new Date(),
      periodStart,
    };
    expect(await recordUsage(db, usage)).toBe(true);
    expect(await recordUsage(db, usage)).toBe(false);
    expect(await ledgerBalance(db, { workspaceId: workspace.id, periodStart })).toEqual({
      granted: 100,
      used: 2.5,
      balance: 97.5,
    });
  }, 60_000);

  test("a GitHub token's times come back as the dates that went in, and the database answers", async () => {
    const { user } = await seedDesign(db);
    const expiresAt = new Date(Date.UTC(2031, 4, 6, 7, 8, 9, 123));
    await saveGithubUserToken(db, {
      userId: user.id,
      encryptedAccessToken: "access",
      accessTokenExpiresAt: expiresAt,
      encryptedRefreshToken: "refresh",
      refreshTokenExpiresAt: null,
    });
    const until = new Date(expiresAt.getTime() + 30_000);

    const claimed = await claimGithubTokenRefresh(db, {
      userId: user.id,
      now: expiresAt,
      staleAt: expiresAt,
      until,
    });

    expect(claimed).toMatchObject({ accessTokenExpiresAt: expiresAt, refreshClaimedUntil: until });
    await releaseGithubTokenRefresh(db, { userId: user.id, until });
    expect((await getGithubUserToken(db, user.id))!.refreshClaimedUntil).toBeNull();
    expect((await getUserByWorkosId(db, user.workosUserId))!.id).toBe(user.id);
    const sessionId = `session_live_${user.id}`;
    await admitSession(db, { id: sessionId, userId: user.id });
    await admitSession(db, { id: sessionId, userId: user.id });
    expect(await getSessionUser(db, sessionId)).toEqual(user);
    await endSession(db, sessionId);
    expect(await getSessionUser(db, sessionId)).toBeNull();
    await pingDb(db);
  }, 60_000);

  test("workspaces, members, install states, deliveries and pull requests", async () => {
    const { workspace, user } = await seedDesign(db);
    const heir = await seedUser(db, "heir");
    const key = { workspaceId: workspace.id, userId: user.id };
    await upsertMembership(db, { ...key, role: "admin", githubAccess: "member" });
    await upsertMembership(db, {
      workspaceId: workspace.id,
      userId: heir.id,
      role: "member",
      githubAccess: "member",
    });

    expect(await setMemberRole(db, { ...key, role: "member" })).toBe("last_admin");
    expect(await countWorkspaceMembers(db, [workspace.id])).toEqual([
      { workspaceId: workspace.id, members: 2 },
    ]);
    const repo = await seedRepo(db, workspace.id, "live/app");
    expect(
      await setMemberRepos(db, {
        ...key,
        repos: [
          { githubRepoId: repo.githubRepoId, canPush: true },
          { githubRepoId: 1, canPush: false },
        ],
        complete: true,
      }),
    ).toEqual({ missing: [1] });
    expect(await listWorkspaceRepos(db, key)).toMatchObject([{ id: repo.id, canPush: true }]);
    expect(await deleteMembershipsExcept(db, { userId: user.id, workspaceIds: [] })).toEqual([
      workspace.id,
    ]);
    expect(await ensureWorkspaceAdmin(db, workspace.id)).toBe(heir.id);
    expect(await listWorkspaceMembers(db, workspace.id)).toMatchObject([
      { userId: heir.id, role: "admin", githubAccess: "member" },
    ]);
    expect(
      await removeMembership(db, { installationId: workspace.installationId!, userId: heir.id }),
    ).toBe(workspace.id);
    expect(
      await listStaleInstallations(db, { before: new Date("2999-01-01T00:00:00Z"), limit: 1 }),
    ).toHaveLength(1);

    const branch = { githubRepoId: repo.githubRepoId, branch: "pz/live" };
    await createDesign(db, {
      workspaceId: workspace.id,
      repoId: repo.id,
      ownerId: user.id,
      claudeAccountId: null,
      name: "Live",
      branch: branch.branch,
      doc: emptyDoc("Live"),
    });
    const updatedAt = new Date("2026-11-10T12:00:00.123Z");
    const settled = await recordPullRequest(db, {
      ...branch,
      number: 2,
      state: "merged",
      updatedAt,
    });
    expect(await findDesignByBranch(db, branch)).toEqual({ id: settled!, status: "settled" });
    expect(await markReposRemovedExcept(db, { workspaceId: workspace.id, githubRepoIds: [] })).toBe(
      1,
    );
    expect(await getRepoInstallationId(db, repo.githubRepoId)).toBe(workspace.installationId);
    expect(await markWorkspaceUninstalled(db, workspace.installationId!)).toBe(workspace.id);
    expect(await wasUninstalled(db, workspace.installationId!)).toBe(true);

    const now = new Date("2026-11-10T12:00:00.456Z");
    const state = await createAuthState(db, {
      kind: "github_install",
      userId: user.id,
      payload: { client: "ios" },
      expiresAt: new Date(now.getTime() + 60_000),
    });
    expect(await consumeAuthState(db, { id: state.id, kind: "github_install", now })).toMatchObject(
      { payload: { client: "ios" }, consumedAt: now },
    );
    const delivery = { source: "github" as const, deliveryId: `live-${state.id}`, event: "ping" };
    const job = {
      kind: "live_webhook",
      payload: { event: "ping" },
      runAt: now,
      lockedBy: "live",
      maxAttempts: 1,
    };
    expect(await takeWebhookDelivery(db, { delivery, job })).toMatch(/^job_/);
    expect(await takeWebhookDelivery(db, { delivery, job })).toBeNull();
  }, 60_000);

  test("a refused statement is a QueryError that names the constraint", async () => {
    const { design } = await seedDesign(db);

    const error = await appendThreadItem(db, {
      designId: design.id,
      kind: "tool",
      payload: { output: `sk-live-secret ${"x".repeat(300_000)}` },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toContain("thread_items_payload_check");
    expect((error as QueryError).message).not.toContain("sk-live");
  }, 60_000);
});
