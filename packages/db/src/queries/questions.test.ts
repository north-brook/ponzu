import { afterAll, beforeAll, expect, test } from "bun:test";
import { seedDesign, seedUser } from "../fixtures.ts";
import { createTestDb } from "../testing.ts";
import { getDesignHead } from "./designs.ts";
import {
  answerQuestion,
  countOpenQuestions,
  createQuestion,
  listOpenQuestions,
} from "./questions.ts";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.$client.close());

const ask = (designId: string, header: string) =>
  createQuestion(db, { designId, kind: "question", payload: { header, options: [] } });

const needsYou = async (designId: string) => (await getDesignHead(db, designId))!.needsYouCount;

test("a question opens and the design's count goes up with it", async () => {
  const { design } = await seedDesign(db);

  const question = await createQuestion(db, {
    designId: design.id,
    kind: "secret",
    payload: { name: "STRIPE_SECRET_KEY" },
  });

  expect(question.id).toMatch(/^q_/);
  expect(question).toMatchObject({
    kind: "secret",
    payload: { name: "STRIPE_SECRET_KEY" },
    status: "open",
    answer: null,
    answeredByUserId: null,
    answeredAt: null,
  });
  expect(await needsYou(design.id)).toBe(1);
  expect(await countOpenQuestions(db, design.id)).toBe(1);
});

test("questions raised at once all count", async () => {
  const { design } = await seedDesign(db);

  await Promise.all(["Layout", "Copy", "Color"].map((header) => ask(design.id, header)));

  expect(await needsYou(design.id)).toBe(3);
  expect(await countOpenQuestions(db, design.id)).toBe(3);
});

test("a question cannot be raised on a design that does not exist", async () => {
  await expect(ask("des_missing", "Anyone?")).rejects.toThrow();
});

test("an answer closes the question, records who gave it and lowers the count", async () => {
  const { design, user } = await seedDesign(db);
  const first = await ask(design.id, "Layout");
  await ask(design.id, "Copy");

  const answered = await answerQuestion(db, {
    designId: design.id,
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
  expect(await needsYou(design.id)).toBe(1);
  expect(await countOpenQuestions(db, design.id)).toBe(1);
});

test("the first answer wins, and the count drops once", async () => {
  const { design, user } = await seedDesign(db);
  const teammate = await seedUser(db, "maya");
  const question = await ask(design.id, "Layout");
  await ask(design.id, "Copy");
  const answer = (userId: string, choice: string) =>
    answerQuestion(db, { designId: design.id, id: question.id, answer: { choice }, userId });

  const results = await Promise.all([answer(user.id, "A"), answer(teammate.id, "B")]);

  const winners = results.filter((result) => result !== null);
  expect(winners).toHaveLength(1);
  expect(await answer(user.id, "C")).toBeNull();
  expect(await needsYou(design.id)).toBe(1);
  expect(await countOpenQuestions(db, design.id)).toBe(1);
});

test("a question is answered through its own design only", async () => {
  const one = await seedDesign(db);
  const other = await seedDesign(db);
  const question = await ask(one.design.id, "Layout");
  await ask(other.design.id, "Theirs");

  const reached = await answerQuestion(db, {
    designId: other.design.id,
    id: question.id,
    answer: {},
    userId: other.user.id,
  });

  expect(reached).toBeNull();
  expect(await needsYou(one.design.id)).toBe(1);
  expect(await needsYou(other.design.id)).toBe(1);
});

test("open questions are listed in the order they were asked", async () => {
  const { design, user } = await seedDesign(db);
  const layout = await ask(design.id, "Layout");
  await ask(design.id, "Copy");
  await ask(design.id, "Color");
  await answerQuestion(db, { designId: design.id, id: layout.id, answer: {}, userId: user.id });

  const open = await listOpenQuestions(db, design.id);

  expect(open.map((question) => (question.payload as { header: string }).header)).toEqual([
    "Copy",
    "Color",
  ]);
  expect(await countOpenQuestions(db, "des_missing")).toBe(0);
});
