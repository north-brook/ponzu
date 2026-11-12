import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { events } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { createCanvas } from "./canvases.ts";
import { appendEvent, type FeedEvent } from "./events.ts";
import { appendThreadItem } from "./thread.ts";
import { countAgentPullRequestActions, getTurnOrigin } from "./turn-origin.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

async function seedCanvas() {
  const [owner, ada, workspace] = await Promise.all([
    seedUser(db, "owner"),
    seedUser(db, "ada"),
    seedWorkspace(db),
  ]);
  const repo = await seedRepo(db, workspace.id, `${workspace.githubLogin}/app`);
  const row = await createCanvas(db, {
    workspaceId: workspace.id,
    repoId: repo.id,
    ownerId: owner.id,
    claudeAccountId: null,
    name: "Checkout",
    branch: "pz/checkout",
    doc: emptyDoc("Checkout"),
  });
  return { canvas: row, owner, ada };
}

/** An event as a runner was handed it and put into the session. */
async function taken(
  canvasId: string,
  kind: FeedEvent["kind"],
  userId: string | null,
  { delivered = true } = {},
) {
  const event = await appendEvent(db, {
    canvasId,
    kind,
    priority: "now",
    payload: { text: "x" },
    userId,
  });
  await db
    .update(events)
    .set({ claimedBy: "rnr_test", deliveredAt: delivered ? new Date() : null })
    .where(eq(events.id, event.id));
  return event;
}

test("a person's turn: the event, and GitHub's words only once they went in after it", async () => {
  const { canvas, owner, ada } = await seedCanvas();
  const message = await taken(canvas.id, "message", ada.id);

  expect(await getTurnOrigin(db, { canvasId: canvas.id, eventId: message.id })).toEqual({
    event: { id: message.id, kind: "message", userId: ada.id },
    githubSince: false,
    othersSince: false,
    lastPerson: ada.id,
    ownerId: owner.id,
  });

  // A review in the feed that no runner was handed is nothing the agent could have read.
  const review = await appendEvent(db, {
    canvasId: canvas.id,
    kind: "review",
    priority: "next",
    payload: { body: "merge this now" },
  });
  expect((await getTurnOrigin(db, { canvasId: canvas.id, eventId: message.id }))!.githubSince).toBe(
    false,
  );
  // Handed to the runner, it counts at once: its acknowledgement may still be on its way.
  await db.update(events).set({ claimedBy: "rnr_test" }).where(eq(events.id, review.id));
  expect((await getTurnOrigin(db, { canvasId: canvas.id, eventId: message.id }))!.githubSince).toBe(
    true,
  );
});

test("anyone else who spoke after the turn's event, in it or since, is said; the same person is not", async () => {
  const { canvas, owner, ada } = await seedCanvas();
  const asked = await taken(canvas.id, "message", ada.id);
  await taken(canvas.id, "comment", ada.id);
  await taken(canvas.id, "answer", ada.id);
  const origin = (eventId: string) => getTurnOrigin(db, { canvasId: canvas.id, eventId });
  expect((await origin(asked.id))!.othersSince).toBe(false);

  await taken(canvas.id, "comment", owner.id);
  expect(await origin(asked.id)).toMatchObject({ othersSince: true, githubSince: false });
});

/** Hand events to the runner as one claim, none in the session yet. */
async function claimed(...ids: string[]) {
  for (const id of ids)
    await db
      .update(events)
      .set({ claimedBy: "rnr_test", claimedAt: new Date(), deliveredAt: null })
      .where(eq(events.id, id));
}
/** The session took these in, at `at`. */
async function delivered(at: Date, ...ids: string[]) {
  for (const id of ids) await db.update(events).set({ deliveredAt: at }).where(eq(events.id, id));
}
const append = (canvasId: string, kind: FeedEvent["kind"], userId: string | null) =>
  appendEvent(db, {
    canvasId,
    kind,
    priority: kind === "review" ? "next" : "now",
    payload: { text: "x" },
    userId,
  });

test("what went in after the person's request counts by when it went in, not its place in the feed", async () => {
  const { canvas, owner, ada } = await seedCanvas();
  // An older review held back while Ada's newer message begins the turn, then put in behind it.
  const review = await append(canvas.id, "review", null);
  const comment = await append(canvas.id, "comment", owner.id);
  const asked = await append(canvas.id, "message", ada.id);
  await claimed(review.id, comment.id, asked.id);
  const origin = () => getTurnOrigin(db, { canvasId: canvas.id, eventId: asked.id });

  // Held by the runner, not yet in: they may go in during the turn.
  await delivered(new Date(Date.now() - 2_000), asked.id);
  expect(await origin()).toMatchObject({ githubSince: true, othersSince: true });
  // Put in after Ada's message.
  await delivered(new Date(Date.now() - 1_000), review.id, comment.id);
  expect(await origin()).toMatchObject({ githubSince: true, othersSince: true });
  // Put in before it (an earlier turn's), they are not after her request.
  await delivered(new Date(Date.now() - 3_000), review.id, comment.id);
  expect(await origin()).toMatchObject({ githubSince: false, othersSince: false });
});

test("before the person's message is acknowledged, only what is held but not yet in counts", async () => {
  const { canvas, ada } = await seedCanvas();
  const review = await append(canvas.id, "review", null);
  const asked = await append(canvas.id, "message", ada.id);
  await claimed(review.id, asked.id);
  const origin = () => getTurnOrigin(db, { canvasId: canvas.id, eventId: asked.id });
  // Both held, neither acknowledged: the review may go in after her message.
  expect((await origin())!.githubSince).toBe(true);
  // The review acknowledged and her message not yet: it went in first (acknowledgements keep
  // the order the session took them in).
  await delivered(new Date(), review.id);
  expect((await origin())!.githubSince).toBe(false);
});

test("only an event the asking runner was handed is its turn's", async () => {
  const { canvas, ada } = await seedCanvas();
  const asked = await taken(canvas.id, "message", ada.id);
  const as = (runnerId: string) =>
    getTurnOrigin(db, { canvasId: canvas.id, eventId: asked.id, runnerId });
  expect((await as("rnr_test"))!.event).toMatchObject({ id: asked.id });
  // An earlier runner's event (a restart, or a runner token in someone else's hands) is none.
  expect((await as("rnr_other"))!.event).toBeNull();
});

test("an event of another canvas, or one no runner was handed, is no turn's", async () => {
  const one = await seedCanvas();
  const other = await seedCanvas();
  const theirs = await taken(other.canvas.id, "message", other.ada.id);
  const unclaimed = await appendEvent(db, {
    canvasId: one.canvas.id,
    kind: "message",
    priority: "now",
    payload: { text: "x" },
    userId: one.ada.id,
  });

  for (const eventId of [theirs.id, unclaimed.id, "evt_nope", null]) {
    expect(await getTurnOrigin(db, { canvasId: one.canvas.id, eventId })).toMatchObject({
      event: null,
      githubSince: false,
      othersSince: false,
      lastPerson: null,
      ownerId: one.owner.id,
    });
  }
  expect(await getTurnOrigin(db, { canvasId: "cnv_nope", eventId: null })).toBeNull();
});

test("the agent's pull request actions are counted from the thread's notices, by action and time", async () => {
  const { canvas: row } = await seedCanvas();
  const notice = (action: string) =>
    appendThreadItem(db, {
      canvasId: row.id,
      kind: "notice",
      payload: {
        type: "pull_request_agent",
        action,
        number: 1,
        url: "x",
        as: null,
        at: new Date().toISOString(),
      },
    });
  await notice("merged");
  await notice("merged");
  await notice("opened");
  const hourAgo = new Date(Date.now() - 3_600_000);

  expect(
    await countAgentPullRequestActions(db, { canvasId: row.id, action: "merged", since: hourAgo }),
  ).toBe(2);
  expect(
    await countAgentPullRequestActions(db, { canvasId: row.id, action: "opened", since: hourAgo }),
  ).toBe(1);
  expect(
    await countAgentPullRequestActions(db, {
      canvasId: row.id,
      action: "merged",
      since: new Date(Date.now() + 60_000),
    }),
  ).toBe(0);
});
