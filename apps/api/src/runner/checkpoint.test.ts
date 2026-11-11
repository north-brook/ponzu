import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sampleDoc } from "@ponzu/core/fixtures";
import { beginSandbox, getDesignAssetKey, getLiveSandbox } from "@ponzu/db";
import {
  call,
  designWithRunner,
  type StartedRunner,
  startRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

/*
 * A runner's checkpoints through the routes (docs/cloud.md, "Saving the sandbox"): archives that
 * no client can reach, a turn marker that only goes up, reading them back, and a rollback logged
 * with the sandbox it happened in.
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
  test("a transcript is stored where no design key reaches it, and can only be recorded by a checkpoint", async () => {
    const { design, runner } = await designWithRunner(t, ws, "maya", sampleDoc());
    const assetKey = await getDesignAssetKey(t.db, design.id);
    const transcript = bytes("the whole conversation");
    const { id, key } = await archive(runner, "session", transcript);

    expect(key.startsWith("private/")).toBe(true);
    expect(key).not.toContain(assetKey);
    expect(key).not.toContain(design.id);
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
    const head = await call(t, ws.people.maya!.headers, "GET", `/v1/designs/${design.id}`);
    expect(JSON.stringify(head.body)).not.toContain(key.split("/")[1]!);
  });

  test("an archive is the right kind and size or it is refused", async () => {
    const { runner } = await designWithRunner(t, ws, "maya", sampleDoc());
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
    const { design, runner } = await designWithRunner(t, ws, "maya", sampleDoc());
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

    const next = await startRunner(t, design.id);
    expect(next.session.saved).toMatchObject({ turn: 2, claudeSessionId: "sess-1", session: true });
    // The one before is superseded: it records nothing.
    const superseded = await send(runner, "POST", "/checkpoint", point(3));
    expect(superseded.status).toBe(409);
  });

  test("restore hands back addresses that read the archives as they were stored, for ten minutes", async () => {
    const { design, runner } = await designWithRunner(t, ws, "maya", sampleDoc());
    expect((await send(runner, "POST", "/restore")).body).toEqual({
      saved: null,
      session: null,
      workspace: null,
    });
    const transcript = bytes("the whole conversation");
    const { id } = await archive(runner, "session", transcript);
    await send(runner, "POST", "/checkpoint", point(4, { session: id }));

    const next = await startRunner(t, design.id);
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

  test("a rollback is logged with the sandbox it happened in, and counted", async () => {
    const { design, runner } = await designWithRunner(t, ws, "maya", sampleDoc());
    await beginSandbox(t.db, {
      designId: design.id,
      provider: "boat",
      now: new Date(t.clock.now()),
      by: "job_test",
      limits: { perWorkspace: 100, perOwner: 100 },
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
    expect((await send(runner, "POST", "/restored", report)).status).toBe(204);
    const sandbox = (await getLiveSandbox(t.db, design.id))!;
    expect(sandbox.rollbacks).toBe(2);
    expect(
      t.logs.findLast((l) => l.event === "sandbox_rollback" && l.designId === design.id),
    ).toMatchObject({
      level: "warn",
      sandboxId: sandbox.id,
      generation: 1,
      rollbacks: 2,
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
    expect((await getLiveSandbox(t.db, design.id))!.rollbacks).toBe(2);
    expect(
      t.logs.findLast((l) => l.event === "sandbox_rebuilt" && l.designId === design.id),
    ).toMatchObject({ level: "info", savedTurn: 5, diskTurn: null });
  });

  test("a checkpoint can keep the archives of the one before in place of those it does not carry", async () => {
    const { runner } = await designWithRunner(t, ws, "maya", sampleDoc());
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

  test("deleting a design deletes its checkpoints' archives, recorded or not", async () => {
    const { design, runner } = await designWithRunner(t, ws, "maya", sampleDoc());
    const recorded = await archive(runner, "session", bytes("the whole conversation"));
    await send(runner, "POST", "/checkpoint", point(1, { session: recorded.id }));
    const unrecorded = await archive(runner, "workspace", bytes("never recorded"));
    const { headers } = await t.signInAs({ login: "maya" });
    const deleted = await call(t, headers, "DELETE", `/v1/designs/${design.id}`);
    expect(deleted.status).toBe(204);
    await t.backgroundDone();
    expect(t.storage.objects.has(recorded.key)).toBe(false);
    expect(t.storage.objects.has(unrecorded.key)).toBe(false);
  });
});
