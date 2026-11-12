import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { seedCanvas, seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { events, questions, repoSecrets } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { createCanvas, getCanvasHead } from "./canvases.ts";
import {
  answerQuestion,
  answerSecretQuestion,
  cancelQuestions,
  countOpenQuestions,
  createQuestion,
  getQuestion,
  listOpenQuestions,
} from "./questions.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const ask = (canvasId: string, header: string) =>
  createQuestion(db, { canvasId, kind: "question", payload: { header, options: [] } });

const needsYou = async (canvasId: string) => (await getCanvasHead(db, canvasId))!.needsYouCount;

test("a question opens and the canvas's count goes up with it", async () => {
  const { canvas } = await seedCanvas(db);

  const question = await createQuestion(db, {
    canvasId: canvas.id,
    kind: "secret",
    payload: { name: "STRIPE_SECRET_KEY" },
  });

  expect(question.id).toMatch(/^q_/);
  expect(question).toMatchObject({ status: "open", raised: true });
  expect(await getQuestion(db, { canvasId: canvas.id, id: question.id })).toMatchObject({
    kind: "secret",
    payload: { name: "STRIPE_SECRET_KEY" },
    status: "open",
    answer: null,
    answeredByUserId: null,
    answeredAt: null,
  });
  expect(await needsYou(canvas.id)).toBe(1);
  expect(await countOpenQuestions(db, canvas.id)).toBe(1);
});

test("a question raised again under its id changes nothing and says where it stands", async () => {
  const { canvas, user } = await seedCanvas(db);
  const raise = (header: string) =>
    createQuestion(db, {
      canvasId: canvas.id,
      id: "q_0000000000000001",
      kind: "plan",
      payload: { header },
    });
  expect(await raise("First")).toEqual({ id: "q_0000000000000001", status: "open", raised: true });

  expect(await raise("Again")).toEqual({ id: "q_0000000000000001", status: "open", raised: false });
  expect(await needsYou(canvas.id)).toBe(1);
  await answerQuestion(db, {
    canvasId: canvas.id,
    id: "q_0000000000000001",
    answer: { approved: true },
    userId: user.id,
  });
  expect(await raise("Late")).toMatchObject({ status: "answered", raised: false });
  expect(await needsYou(canvas.id)).toBe(0);
  const stored = await getQuestion(db, { canvasId: canvas.id, id: "q_0000000000000001" });
  expect(stored!.payload).toEqual({ header: "First" });
});

test("the same question id in two canvases is two questions", async () => {
  const one = await seedCanvas(db);
  const other = await seedCanvas(db);
  const id = "q_0000000000000002";

  await createQuestion(db, { canvasId: one.canvas.id, id, kind: "plan", payload: { plan: "A" } });
  const theirs = await createQuestion(db, {
    canvasId: other.canvas.id,
    id,
    kind: "plan",
    payload: { plan: "B" },
  });

  expect(theirs.raised).toBe(true);
  expect((await getQuestion(db, { canvasId: one.canvas.id, id }))!.payload).toEqual({ plan: "A" });
  expect((await getQuestion(db, { canvasId: other.canvas.id, id }))!.payload).toEqual({
    plan: "B",
  });
  expect(await getQuestion(db, { canvasId: one.canvas.id, id: "q_missing" })).toBeNull();
});

test("an answer is an event that carries the question as it was raised", async () => {
  const { canvas, user } = await seedCanvas(db);
  const payload = { questions: [{ header: "Layout", question: "Which?", options: [] }] };
  const { id } = await createQuestion(db, { canvasId: canvas.id, kind: "question", payload });

  await answerQuestion(db, {
    canvasId: canvas.id,
    id,
    answer: { answers: { "Which?": "Two columns" } },
    userId: user.id,
  });
  await answerQuestion(db, { canvasId: canvas.id, id, answer: { answers: {} }, userId: user.id });

  const feed = await db.select().from(events).where(eq(events.canvasId, canvas.id));
  expect(feed).toHaveLength(1);
  expect(feed[0]).toMatchObject({
    kind: "answer",
    priority: "now",
    userId: user.id,
    payload: {
      questionId: id,
      question: { kind: "question", payload },
      answers: { "Which?": "Two columns" },
    },
  });
});

test("questions raised at once all count", async () => {
  const { canvas } = await seedCanvas(db);

  await Promise.all(["Layout", "Copy", "Color"].map((header) => ask(canvas.id, header)));

  expect(await needsYou(canvas.id)).toBe(3);
  expect(await countOpenQuestions(db, canvas.id)).toBe(3);
});

test("a question cannot be raised on a canvas that does not exist", async () => {
  await expect(ask("cnv_missing", "Anyone?")).rejects.toThrow();
});

test("an answer closes the question, records who gave it and lowers the count", async () => {
  const { canvas, user } = await seedCanvas(db);
  const first = await ask(canvas.id, "Layout");
  await ask(canvas.id, "Copy");

  const answered = await answerQuestion(db, {
    canvasId: canvas.id,
    id: first.id,
    answer: { options: ["Two columns"], note: "Keep the photo" },
    userId: user.id,
  });

  expect(answered).toMatchObject({
    id: first.id,
    status: "answered",
    answer: { options: ["Two columns"], note: "Keep the photo" },
    answeredByUserId: user.id,
  });
  expect(answered!.answeredAt).toBeInstanceOf(Date);
  expect(await needsYou(canvas.id)).toBe(1);
  expect(await countOpenQuestions(db, canvas.id)).toBe(1);
});

test("the first answer wins, and the count drops once", async () => {
  const { canvas, user } = await seedCanvas(db);
  const teammate = await seedUser(db, "maya");
  const question = await ask(canvas.id, "Layout");
  await ask(canvas.id, "Copy");
  const answer = (userId: string, choice: string) =>
    answerQuestion(db, { canvasId: canvas.id, id: question.id, answer: { choice }, userId });

  const results = await Promise.all([answer(user.id, "A"), answer(teammate.id, "B")]);

  const winners = results.filter((result) => result !== null);
  expect(winners).toHaveLength(1);
  expect(await answer(user.id, "C")).toBeNull();
  expect(await needsYou(canvas.id)).toBe(1);
  expect(await countOpenQuestions(db, canvas.id)).toBe(1);
});

test("a question is answered through its own canvas only", async () => {
  const one = await seedCanvas(db);
  const other = await seedCanvas(db);
  const question = await ask(one.canvas.id, "Layout");
  await ask(other.canvas.id, "Theirs");

  const reached = await answerQuestion(db, {
    canvasId: other.canvas.id,
    id: question.id,
    answer: {},
    userId: other.user.id,
  });

  expect(reached).toBeNull();
  expect(await needsYou(one.canvas.id)).toBe(1);
  expect(await needsYou(other.canvas.id)).toBe(1);
});

test("open questions are listed in the order they were asked", async () => {
  const { canvas, user } = await seedCanvas(db);
  const layout = await ask(canvas.id, "Layout");
  await ask(canvas.id, "Copy");
  await ask(canvas.id, "Color");
  await answerQuestion(db, { canvasId: canvas.id, id: layout.id, answer: {}, userId: user.id });

  const open = await listOpenQuestions(db, canvas.id);

  expect(open.map((question) => (question.payload as { header: string }).header)).toEqual([
    "Copy",
    "Color",
  ]);
  expect(await countOpenQuestions(db, "cnv_missing")).toBe(0);
});

/** A canvas in a repo, with an open question asking for one of the repo's secrets. */
async function canvasAskingForSecret() {
  const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
  const repo = await seedRepo(db, workspace.id);
  const canvas = await createCanvas(db, {
    workspaceId: workspace.id,
    repoId: repo.id,
    ownerId: user.id,
    claudeAccountId: null,
    name: "checkout",
    branch: "pz/checkout",
    doc: emptyDoc("checkout"),
  });
  const question = await createQuestion(db, {
    canvasId: canvas.id,
    kind: "secret",
    payload: { name: "STRIPE_SECRET_KEY", text: "Checkout needs STRIPE_SECRET_KEY to run." },
  });
  return { user, repo, canvas, question };
}

const secretsOf = (repoId: string) =>
  db.select().from(repoSecrets).where(eq(repoSecrets.repoId, repoId));

test("a secret's answer keeps the value with the repo, encrypted, and off the question", async () => {
  const { user, repo, canvas, question } = await canvasAskingForSecret();

  const answered = await answerSecretQuestion(db, {
    canvasId: canvas.id,
    id: question.id,
    name: "STRIPE_SECRET_KEY",
    encryptedValue: "v1.ciphertext",
    valueBytes: 24,
    userId: user.id,
  });

  // The question is in a table clients watch: it says which secret was given, never the value.
  expect(answered).toMatchObject({
    status: "answered",
    answer: { name: "STRIPE_SECRET_KEY" },
    answeredByUserId: user.id,
  });
  expect(await secretsOf(repo.id)).toMatchObject([
    { name: "STRIPE_SECRET_KEY", encryptedValue: "v1.ciphertext", updatedByUserId: user.id },
  ]);
  expect(await needsYou(canvas.id)).toBe(0);
});

test("a secret given again replaces the repo's value, and a second answer changes nothing", async () => {
  const { user, repo, canvas, question } = await canvasAskingForSecret();
  const give = (id: string, encryptedValue: string) =>
    answerSecretQuestion(db, {
      canvasId: canvas.id,
      id,
      name: "STRIPE_SECRET_KEY",
      encryptedValue,
      valueBytes: 24,
      userId: user.id,
    });
  await give(question.id, "v1.first");

  // The same question answered twice: the first answer stands, and so does its value.
  expect(await give(question.id, "v1.late")).toBeNull();
  expect(await secretsOf(repo.id)).toMatchObject([{ encryptedValue: "v1.first" }]);

  // Claude asks again later, for a key that works.
  const again = await createQuestion(db, { canvasId: canvas.id, kind: "secret", payload: {} });
  expect(await give(again.id, "v1.second")).not.toBeNull();
  expect(await secretsOf(repo.id)).toMatchObject([{ encryptedValue: "v1.second" }]);
});

test("a secret question cannot be answered in the clear", async () => {
  const { user, repo, canvas, question } = await canvasAskingForSecret();

  // The ordinary path does not answer it at all.
  const plain = await answerQuestion(db, {
    canvasId: canvas.id,
    id: question.id,
    answer: { value: "sk-live-123" },
    userId: user.id,
  });
  expect(plain).toBeNull();
  // And the table itself refuses a secret's answer that carries anything but its name.
  const direct = db
    .update(questions)
    .set({ status: "answered", answer: { name: "STRIPE_SECRET_KEY", value: "sk-live-123" } })
    .where(eq(questions.id, question.id));
  await expect(Promise.resolve(direct)).rejects.toThrow();

  expect(await listOpenQuestions(db, canvas.id)).toHaveLength(1);
  expect(await secretsOf(repo.id)).toEqual([]);
});

test("only an open secret question of a canvas in a repo takes a secret", async () => {
  const { user, repo, canvas } = await canvasAskingForSecret();
  const ordinary = await ask(canvas.id, "Layout");
  const scratch = await seedCanvas(db);
  const scratchQuestion = await createQuestion(db, {
    canvasId: scratch.canvas.id,
    kind: "secret",
    payload: {},
  });
  const give = (canvasId: string, id: string) =>
    answerSecretQuestion(db, {
      canvasId,
      id,
      name: "KEY",
      encryptedValue: "v1.x",
      valueBytes: 3,
      userId: user.id,
    });

  // Not a secret question; and Scratch has no repo for a secret to belong to.
  expect(await give(canvas.id, ordinary.id)).toBeNull();
  expect(await give(scratch.canvas.id, scratchQuestion.id)).toBeNull();

  expect(await secretsOf(repo.id)).toEqual([]);
  expect(await needsYou(canvas.id)).toBe(2);
  expect(await needsYou(scratch.canvas.id)).toBe(1);
});

test("cancelling closes a canvas's open questions and takes them off the count", async () => {
  const { canvas, user } = await seedCanvas(db);
  const other = await seedCanvas(db);
  const layout = await ask(canvas.id, "Layout");
  await ask(canvas.id, "Copy");
  await ask(canvas.id, "Color");
  await ask(other.canvas.id, "Theirs");
  await answerQuestion(db, { canvasId: canvas.id, id: layout.id, answer: {}, userId: user.id });

  // The run was stopped with two questions up.
  expect(await cancelQuestions(db, { canvasId: canvas.id })).toBe(2);

  expect(await needsYou(canvas.id)).toBe(0);
  expect(await listOpenQuestions(db, canvas.id)).toEqual([]);
  const rows = await db.select().from(questions).where(eq(questions.canvasId, canvas.id));
  expect(rows.map((row) => row.status).sort()).toEqual(["answered", "cancelled", "cancelled"]);
  // Nothing left to close, and the other canvas was not touched.
  expect(await cancelQuestions(db, { canvasId: canvas.id })).toBe(0);
  expect(await needsYou(other.canvas.id)).toBe(1);
});

test("cancelling by id closes only those, once, and only in their own canvas", async () => {
  const { canvas, user } = await seedCanvas(db);
  const other = await seedCanvas(db);
  const layout = await ask(canvas.id, "Layout");
  const copy = await ask(canvas.id, "Copy");
  const theirs = await ask(other.canvas.id, "Theirs");

  expect(await cancelQuestions(db, { canvasId: canvas.id, ids: [layout.id, theirs.id] })).toBe(1);
  expect(await cancelQuestions(db, { canvasId: canvas.id, ids: [layout.id] })).toBe(0);
  expect(await cancelQuestions(db, { canvasId: canvas.id, ids: [] })).toBe(0);

  expect(await needsYou(canvas.id)).toBe(1);
  expect(await needsYou(other.canvas.id)).toBe(1);
  // A cancelled question is closed: it cannot be answered afterwards.
  const late = await answerQuestion(db, {
    canvasId: canvas.id,
    id: layout.id,
    answer: {},
    userId: user.id,
  });
  expect(late).toBeNull();
  expect((await listOpenQuestions(db, canvas.id)).map((question) => question.id)).toEqual([
    copy.id,
  ]);
});
