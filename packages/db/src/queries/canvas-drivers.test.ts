import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { seedCanvas, seedUser } from "../fixtures.ts";
import { canvasDrivers } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import {
  approveAgentAuthorization,
  consumeAgentCode,
  createAgentAuthorization,
  registerAgentClient,
} from "./agents.ts";
import {
  getCanvasDriver,
  listLapsedDrivers,
  releaseCanvasDriver,
  takeCanvasDriver,
  touchCanvasDriver,
} from "./canvas-drivers.ts";
import { getCanvasHead } from "./canvases.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

async function grantFor(userId: string, name = "Claude Code"): Promise<string> {
  const client = await registerAgentClient(db, {
    name,
    redirectUris: ["http://localhost/cb"],
    metadata: {},
  });
  const id = await createAgentAuthorization(db, {
    clientId: client.id,
    redirectUri: "http://localhost/cb",
    codeChallenge: "c",
    state: null,
    scope: null,
    resource: null,
  });
  const approved = await approveAgentAuthorization(db, { id, userId, name });
  return (await consumeAgentCode(db, { code: approved!.code, clientId: client.id }))!;
}

const claim = (canvasId: string, grantId: string, userId: string, name = "Claude Code") => ({
  canvasId,
  grantId,
  userId,
  client: "claude",
  name,
  host: "T3 Code",
  version: "claude-code/2.1.0",
});

async function lapse(canvasId: string) {
  await db
    .update(canvasDrivers)
    .set({ seenAt: sql`now() - interval '31 minutes'` })
    .where(eq(canvasDrivers.canvasId, canvasId));
}

test("taking a canvas shows the agent on its head; renewing keeps when it began", async () => {
  const { canvas, user: owner } = await seedCanvas(db);
  const grant = await grantFor(owner.id);
  const taken = await takeCanvasDriver(db, claim(canvas.id, grant, owner.id));
  expect(taken.taken).toBe(true);
  const head = await getCanvasHead(db, canvas.id);
  expect(head?.driver).toMatchObject({ client: "claude", name: "Claude Code", host: "T3 Code" });
  expect(new Date(head!.driver!.since).getTime()).toBeGreaterThan(0);

  const since = head!.driver!.since;
  await takeCanvasDriver(db, claim(canvas.id, grant, owner.id));
  expect((await getCanvasHead(db, canvas.id))?.driver?.since).toBe(since);
  expect(await touchCanvasDriver(db, { canvasId: canvas.id, grantId: grant })).toBe(true);
});

test("someone else's live lease is not taken; an over one is", async () => {
  const { canvas, user: owner } = await seedCanvas(db);
  const other = await seedUser(db, "ines");
  const mine = await grantFor(owner.id);
  const theirs = await grantFor(other.id, "Codex");
  await takeCanvasDriver(db, claim(canvas.id, mine, owner.id));

  const refused = await takeCanvasDriver(db, claim(canvas.id, theirs, other.id, "Codex"));
  expect(refused).toMatchObject({ taken: false, holder: { grantId: mine } });
  expect((await getCanvasHead(db, canvas.id))?.driver?.name).toBe("Claude Code");

  await lapse(canvas.id);
  expect(await getCanvasDriver(db, canvas.id)).toBeNull();
  expect(await touchCanvasDriver(db, { canvasId: canvas.id, grantId: mine })).toBe(false);
  expect(await listLapsedDrivers(db)).toContain(canvas.id);
  const taken = await takeCanvasDriver(db, claim(canvas.id, theirs, other.id, "Codex"));
  expect(taken.taken).toBe(true);
  expect((await getCanvasHead(db, canvas.id))?.driver?.name).toBe("Codex");
});

test("another of the same person's agents takes it over", async () => {
  const { canvas, user: owner } = await seedCanvas(db);
  const first = await grantFor(owner.id);
  const second = await grantFor(owner.id, "Codex");
  await takeCanvasDriver(db, claim(canvas.id, first, owner.id));
  const taken = await takeCanvasDriver(db, claim(canvas.id, second, owner.id, "Codex"));
  expect(taken.taken).toBe(true);
  expect(await touchCanvasDriver(db, { canvasId: canvas.id, grantId: first })).toBe(false);
});

test("releasing ends the lease and clears the head; only the named grant's, or a lapsed one", async () => {
  const { canvas, user: owner } = await seedCanvas(db);
  const grant = await grantFor(owner.id);
  await takeCanvasDriver(db, claim(canvas.id, grant, owner.id));

  expect(await releaseCanvasDriver(db, { canvasId: canvas.id, grantId: "agt_other" })).toBeNull();
  expect(await releaseCanvasDriver(db, { canvasId: canvas.id, lapsed: true })).toBeNull();
  const released = await releaseCanvasDriver(db, { canvasId: canvas.id });
  expect(released).toMatchObject({ grantId: grant, name: "Claude Code" });
  expect(released?.startedAt).toBeInstanceOf(Date);
  expect((await getCanvasHead(db, canvas.id))?.driver).toBeNull();
  expect(await releaseCanvasDriver(db, { canvasId: canvas.id })).toBeNull();
});
