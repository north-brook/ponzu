import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sampleDoc } from "@ponzu/core/fixtures";
import {
  appendEvent,
  beginSandbox,
  canvasRunners,
  getCanvasAssetKey,
  getCheckpointCover,
  moveSandbox,
  newId,
} from "@ponzu/db";
import {
  call,
  canvasWithRunner,
  type StartedRunner,
  startRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

/*
 * A runner's checkpoints through the routes (docs/cloud.md, "Saving the sandbox"): archives that
 * no client can reach, a turn marker that only goes up, reading them back, and a rollback logged
 * with the session it happened in.
 */

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write" });
});
afterAll(() => t.close());

const send = (runner: StartedRunner, method: string, path: string, body?: unknown) =>
  call(t, runner.headers, method, `/v1/runner${path}`, body);
const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

/** Uploads an archive as the runner does, and answers its upload id and where it went. */
async function archive(runner: StartedRunner, purpose: "session" | "workspace", body: Uint8Array) {
  const name = purpose === "session" ? "session.tar.gz" : "workspace.tar.gz";
  const signed = await send(runner, "POST", "/uploads", {
    files: [
      { purpose, name, contentType: "application/gzip", size: body.byteLength, sha256: sha(body) },
    ],
  });
  expect(signed.status).toBe(200);
  const [file] = signed.body.files;
  const put = await t.storage.fetch(file.put.url, {
    method: "PUT",
    headers: file.put.headers,
    body: body as Uint8Array<ArrayBuffer>,
  });
  expect(put.status).toBe(200);
  return {
    id: file.id as string,
    key: decodeURIComponent(new URL(file.put.url).pathname.slice(1)),
  };
}

const point = (turn: number, over: Record<string, unknown> = {}) => ({
  turn,
  claudeSessionId: "sess-1",
  wipCommit: null,
  session: null,
  workspace: null,
  ...over,
});

describe("checkpoints", () => {
  test("a transcript is stored where no canvas key reaches it, and can only be recorded by a checkpoint", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const assetKey = await getCanvasAssetKey(t.db, canvas.id);
    const transcript = bytes("the whole conversation");
    const { id, key } = await archive(runner, "session", transcript);

    expect(key.startsWith("private/")).toBe(true);
    expect(key).not.toContain(assetKey);
    expect(key).not.toContain(canvas.id);
    expect(t.storage.objects.get(key)!.headers["cache-control"]).toBe("private, no-store");
    // The public path would answer an assets address: refused.
    const completed = await send(runner, "POST", "/uploads/complete", { ids: [id] });
    expect(completed.status).toBe(400);

    const recorded = await send(runner, "POST", "/checkpoint", point(1, { session: id }));
    expect(recorded.status).toBe(200);
    expect(recorded.body.saved).toEqual({
      turn: 1,
      at: new Date(t.clock.now()).toISOString(),
      claudeSessionId: "sess-1",
      wipCommit: null,
      session: true,
      workspace: false,
    });
    // Nothing a client reads names the key.
    const head = await call(t, ws.people.maya!.headers, "GET", `/v1/canvases/${canvas.id}`);
    expect(JSON.stringify(head.body)).not.toContain(key.split("/")[1]!);
  });

  test("an archive is the right kind and size or it is refused", async () => {
    const { runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const body = bytes("x");
    const declared = (over: Record<string, unknown>) => ({
      files: [
        {
          purpose: "session",
          name: "session.tar.gz",
          contentType: "application/gzip",
          size: 1,
          sha256: sha(body),
          ...over,
        },
      ],
    });
    expect(
      (await send(runner, "POST", "/uploads", declared({ name: "notes.tar.gz" }))).status,
    ).toBe(400);
    expect(
      (await send(runner, "POST", "/uploads", declared({ contentType: "image/png" }))).status,
    ).toBe(415);
    expect(
      (await send(runner, "POST", "/uploads", declared({ size: 65 * 1024 * 1024 }))).status,
    ).toBe(413);
    // An id that is not this runner's archive of that kind, or whose bytes never came.
    const { id } = await archive(runner, "workspace", body);
    expect((await send(runner, "POST", "/checkpoint", point(1, { session: id }))).status).toBe(404);
    const signed = await send(runner, "POST", "/uploads", declared({}));
    const missing = signed.body.files[0].id;
    expect((await send(runner, "POST", "/checkpoint", point(1, { session: missing }))).status).toBe(
      404,
    );
  });

  test("the marker only goes up, the next runner is told it, and replaced archives are deleted", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const one = await archive(runner, "session", bytes("turn one"));
    const work = await archive(runner, "workspace", bytes("files"));
    await send(runner, "POST", "/checkpoint", point(1, { session: one.id, workspace: work.id }));
    const two = await archive(runner, "session", bytes("turn two"));
    const later = await send(
      runner,
      "POST",
      "/checkpoint",
      point(2, { session: two.id, wipCommit: "a".repeat(40) }),
    );
    expect(later.body.saved).toMatchObject({
      turn: 2,
      session: true,
      workspace: false,
      wipCommit: "a".repeat(40),
    });
    await t.backgroundDone();
    expect(t.storage.objects.has(one.key)).toBe(false);
    expect(t.storage.objects.has(work.key)).toBe(false);
    expect(t.storage.objects.has(two.key)).toBe(true);

    // An older one, late: the newer stays, and its archive goes.
    const stale = await archive(runner, "session", bytes("turn one again"));
    const late = await send(runner, "POST", "/checkpoint", point(1, { session: stale.id }));
    expect(late.body.saved.turn).toBe(2);
    await t.backgroundDone();
    expect(t.storage.objects.has(stale.key)).toBe(false);
    expect(t.storage.objects.has(two.key)).toBe(true);

    const next = await startRunner(t, canvas.id);
    expect(next.session.saved).toMatchObject({ turn: 2, claudeSessionId: "sess-1", session: true });
    // The one before is superseded: it records nothing.
    const superseded = await send(runner, "POST", "/checkpoint", point(3));
    expect(superseded.status).toBe(409);
  });

  test("restore hands back addresses that read the archives as they were stored, for ten minutes", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    expect((await send(runner, "POST", "/restore")).body).toEqual({
      saved: null,
      session: null,
      workspace: null,
    });
    const transcript = bytes("the whole conversation");
    const { id } = await archive(runner, "session", transcript);
    await send(runner, "POST", "/checkpoint", point(4, { session: id }));

    const next = await startRunner(t, canvas.id);
    const restored = await send(next, "POST", "/restore");
    expect(restored.body.saved.turn).toBe(4);
    expect(restored.body.workspace).toBeNull();
    const { url, size, sha256 } = restored.body.session;
    expect({ size, sha256 }).toEqual({ size: transcript.byteLength, sha256: sha(transcript) });
    const read = await t.storage.fetch(url);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(transcript);
    t.clock.advance(11 * 60_000);
    expect((await t.storage.fetch(url)).status).toBe(403);
  });

  test("a rollback is logged with the session it happened in", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const now = new Date(t.clock.now());
    await beginSandbox(t.db, {
      canvasId: canvas.id,
      now,
      by: "job_test",
      limits: { perWorkspace: 100, perOwner: 100 },
    });
    await moveSandbox(t.db, {
      canvasId: canvas.id,
      from: ["waking"],
      to: "awake",
      now,
      by: "job_test",
      changes: { sessionId: "sbx_session_1", image: "ponzu-runner@sha256:aa" },
    });
    const report = {
      kind: "rollback",
      disk: { turn: 3, at: "2026-11-11T09:00:00.000Z", bootId: "boot-a" },
      saved: { turn: 5, at: "2026-11-11T09:30:00.000Z" },
      bootId: "boot-c",
      bootAt: "2026-11-11T09:41:00.000Z",
      restored: { session: true, workspace: true },
    };
    expect((await send(runner, "POST", "/restored", report)).status).toBe(204);
    expect(
      t.logs.findLast((l) => l.event === "sandbox_rollback" && l.canvasId === canvas.id),
    ).toMatchObject({
      level: "warn",
      sessionId: "sbx_session_1",
      image: "ponzu-runner@sha256:aa",
      sandboxState: "awake",
      diskTurn: 3,
      diskBootId: "boot-a",
      savedTurn: 5,
      bootId: "boot-c",
      bootAt: "2026-11-11T09:41:00.000Z",
    });
    const rebuilt = await send(runner, "POST", "/restored", {
      ...report,
      kind: "rebuilt",
      disk: null,
    });
    expect(rebuilt.status).toBe(204);
    expect(
      t.logs.findLast((l) => l.event === "sandbox_rebuilt" && l.canvasId === canvas.id),
    ).toMatchObject({ level: "info", savedTurn: 5, diskTurn: null });
  });

  test("a checkpoint can keep the archives of the one before in place of those it does not carry", async () => {
    const { runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const talk = await archive(runner, "session", bytes("the conversation so far"));
    const work = await archive(runner, "workspace", bytes("a bundle"));
    await send(
      runner,
      "POST",
      "/checkpoint",
      point(1, { session: talk.id, workspace: work.id, wipCommit: "b".repeat(40) }),
    );
    // The transcript outgrew what a checkpoint keeps, and the work did not change.
    const kept = await send(
      runner,
      "POST",
      "/checkpoint",
      point(2, { claudeSessionId: null, keep: { session: true, workspace: true } }),
    );
    expect(kept.body.saved).toMatchObject({
      turn: 2,
      claudeSessionId: "sess-1",
      wipCommit: "b".repeat(40),
      session: true,
      workspace: true,
    });
    await t.backgroundDone();
    expect(t.storage.objects.has(talk.key)).toBe(true);
    expect(t.storage.objects.has(work.key)).toBe(true);
    // Without `keep`, what is not carried is dropped, and its archive deleted.
    const dropped = await send(runner, "POST", "/checkpoint", point(3));
    expect(dropped.body.saved).toMatchObject({ turn: 3, session: false, workspace: false });
    await t.backgroundDone();
    expect(t.storage.objects.has(talk.key)).toBe(false);
  });

  test("deleting a canvas deletes its checkpoints' archives, recorded or not", async () => {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const recorded = await archive(runner, "session", bytes("the whole conversation"));
    await send(runner, "POST", "/checkpoint", point(1, { session: recorded.id }));
    const unrecorded = await archive(runner, "workspace", bytes("never recorded"));
    const { headers } = await t.signInAs({ login: "maya" });
    const deleted = await call(t, headers, "DELETE", `/v1/canvases/${canvas.id}`);
    expect(deleted.status).toBe(204);
    await t.backgroundDone();
    expect(t.storage.objects.has(recorded.key)).toBe(false);
    expect(t.storage.objects.has(unrecorded.key)).toBe(false);
  });
});

describe("what a checkpoint holds", () => {
  /**
   * A canvas whose runner was handed three messages and acknowledged the first two, as one that
   * took the second into a turn: the third is still on its way into the session.
   */
  async function handed() {
    const { canvas, runner } = await canvasWithRunner(t, ws, "maya", sampleDoc());
    const seqs: number[] = [];
    for (const text of ["one", "two", "three"]) {
      const event = await appendEvent(t.db, {
        canvasId: canvas.id,
        kind: "message",
        priority: "now",
        payload: { text },
        userId: ws.people.maya!.userId,
      });
      seqs.push(event.seq);
    }
    const claimed = await send(runner, "POST", "/events/claim", { claimId: newId("clm") });
    const ids = claimed.body.events.map((event: { id: string }) => event.id);
    const acked = await send(runner, "POST", "/events/ack", {
      ids: ids.slice(0, 2),
      claudeSessionId: "sess-1",
    });
    expect(acked.status).toBe(200);
    const through = async () =>
      (await t.db.select().from(canvasRunners)).find((row) => row.canvasId === canvas.id)!
        .savedThrough;
    const cover = () => getCheckpointCover(t.db, canvas.id);
    return { runner, seqs, through, cover };
  }

  test("a runner that does not say what it held counts every event delivered by now, as before", async () => {
    const { runner, seqs, through, cover } = await handed();
    const recorded = await send(runner, "POST", "/checkpoint", point(1));
    expect(recorded.status).toBe(200);
    expect(await through()).toBe(seqs[1]!);
    expect(await cover()).toBe("covered");
  });

  test("a runner that says records what its session held when the archive was taken", async () => {
    const { runner, seqs, through, cover } = await handed();
    const recorded = await send(runner, "POST", "/checkpoint", point(1, { heldThrough: seqs[0] }));
    expect(recorded.status).toBe(200);
    expect(recorded.body.saved.turn).toBe(1);
    expect(await through()).toBe(seqs[0]!);
    // The second message went out but not into this archive: a recreate waits for a later one.
    expect(await cover()).toBe("behind");
  });

  test("never above what was delivered: undelivered events are never counted as held", async () => {
    const { runner, seqs, through } = await handed();
    await send(runner, "POST", "/checkpoint", point(1, { heldThrough: seqs[2]! + 50 }));
    expect(await through()).toBe(seqs[1]!);
  });

  test("a held mark that is not a seq is refused", async () => {
    const { runner } = await handed();
    for (const heldThrough of [-1, 1.5, "3", null])
      expect((await send(runner, "POST", "/checkpoint", point(1, { heldThrough }))).status).toBe(
        400,
      );
  });
});
