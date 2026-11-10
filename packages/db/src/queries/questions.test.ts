import { afterAll, beforeAll, expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";
import { eq } from "drizzle-orm";
import { seedDesign, seedRepo, seedUser, seedWorkspace } from "../fixtures.ts";
import { questions, repoSecrets } from "../schema/index.ts";
import { createTestDb } from "../testing.ts";
import { createDesign, getDesignHead } from "./designs.ts";
import {
  answerQuestion,
  answerSecretQuestion,
  cancelQuestions,
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

/** A design in a repo, with an open question asking for one of the repo's secrets. */
async function designAskingForSecret() {
  const [user, workspace] = await Promise.all([seedUser(db), seedWorkspace(db)]);
  const repo = await seedRepo(db, workspace.id);
  const design = await createDesign(db, {
    workspaceId: workspace.id,
    repoId: repo.id,
    ownerId: user.id,
    claudeAccountId: null,
    name: "checkout",
    branch: "pz/checkout",
    doc: emptyDoc("checkout"),
  });
  const question = await createQuestion(db, {
    designId: design.id,
    kind: "secret",
    payload: { name: "STRIPE_SECRET_KEY", text: "Checkout needs STRIPE_SECRET_KEY to run." },
  });
  return { user, repo, design, question };
}

const secretsOf = (repoId: string) =>
  db.select().from(repoSecrets).where(eq(repoSecrets.repoId, repoId));

test("a secret's answer keeps the value with the repo, encrypted, and off the question", async () => {
  const { user, repo, design, question } = await designAskingForSecret();

  const answered = await answerSecretQuestion(db, {
    designId: design.id,
    id: question.id,
    name: "STRIPE_SECRET_KEY",
    encryptedValue: "v1.ciphertext",
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
  expect(await needsYou(design.id)).toBe(0);
});

test("a secret given again replaces the repo's value, and a second answer changes nothing", async () => {
  const { user, repo, design, question } = await designAskingForSecret();
  const give = (id: string, encryptedValue: string) =>
    answerSecretQuestion(db, {
      designId: design.id,
      id,
      name: "STRIPE_SECRET_KEY",
      encryptedValue,
      userId: user.id,
    });
  await give(question.id, "v1.first");

  // The same question answered twice: the first answer stands, and so does its value.
  expect(await give(question.id, "v1.late")).toBeNull();
  expect(await secretsOf(repo.id)).toMatchObject([{ encryptedValue: "v1.first" }]);

  // Claude asks again later, for a key that works.
  const again = await createQuestion(db, { designId: design.id, kind: "secret", payload: {} });
  expect(await give(again.id, "v1.second")).not.toBeNull();
  expect(await secretsOf(repo.id)).toMatchObject([{ encryptedValue: "v1.second" }]);
});

test("a secret question cannot be answered in the clear", async () => {
  const { user, repo, design, question } = await designAskingForSecret();

  // The ordinary path does not answer it at all.
  const plain = await answerQuestion(db, {
    designId: design.id,
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

  expect(await listOpenQuestions(db, design.id)).toHaveLength(1);
  expect(await secretsOf(repo.id)).toEqual([]);
});

test("only an open secret question of a design in a repo takes a secret", async () => {
  const { user, repo, design } = await designAskingForSecret();
  const ordinary = await ask(design.id, "Layout");
  const scratch = await seedDesign(db);
  const scratchQuestion = await createQuestion(db, {
    designId: scratch.design.id,
    kind: "secret",
    payload: {},
  });
  const give = (designId: string, id: string) =>
    answerSecretQuestion(db, {
      designId,
      id,
      name: "KEY",
      encryptedValue: "v1.x",
      userId: user.id,
    });

  // Not a secret question; and Scratch has no repo for a secret to belong to.
  expect(await give(design.id, ordinary.id)).toBeNull();
  expect(await give(scratch.design.id, scratchQuestion.id)).toBeNull();

  expect(await secretsOf(repo.id)).toEqual([]);
  expect(await needsYou(design.id)).toBe(2);
  expect(await needsYou(scratch.design.id)).toBe(1);
});

test("cancelling closes a design's open questions and takes them off the count", async () => {
  const { design, user } = await seedDesign(db);
  const other = await seedDesign(db);
  const layout = await ask(design.id, "Layout");
  await ask(design.id, "Copy");
  await ask(design.id, "Color");
  await ask(other.design.id, "Theirs");
  await answerQuestion(db, { designId: design.id, id: layout.id, answer: {}, userId: user.id });

  // The run was stopped with two questions up.
  expect(await cancelQuestions(db, { designId: design.id })).toBe(2);

  expect(await needsYou(design.id)).toBe(0);
  expect(await listOpenQuestions(db, design.id)).toEqual([]);
  const rows = await db.select().from(questions).where(eq(questions.designId, design.id));
  expect(rows.map((row) => row.status).sort()).toEqual(["answered", "cancelled", "cancelled"]);
  // Nothing left to close, and the other design was not touched.
  expect(await cancelQuestions(db, { designId: design.id })).toBe(0);
  expect(await needsYou(other.design.id)).toBe(1);
});

test("cancelling by id closes only those, once, and only in their own design", async () => {
  const { design, user } = await seedDesign(db);
  const other = await seedDesign(db);
  const layout = await ask(design.id, "Layout");
  const copy = await ask(design.id, "Copy");
  const theirs = await ask(other.design.id, "Theirs");

  expect(await cancelQuestions(db, { designId: design.id, ids: [layout.id, theirs.id] })).toBe(1);
  expect(await cancelQuestions(db, { designId: design.id, ids: [layout.id] })).toBe(0);
  expect(await cancelQuestions(db, { designId: design.id, ids: [] })).toBe(0);

  expect(await needsYou(design.id)).toBe(1);
  expect(await needsYou(other.design.id)).toBe(1);
  // A cancelled question is closed: it cannot be answered afterwards.
  const late = await answerQuestion(db, {
    designId: design.id,
    id: layout.id,
    answer: {},
    userId: user.id,
  });
  expect(late).toBeNull();
  expect((await listOpenQuestions(db, design.id)).map((question) => question.id)).toEqual([
    copy.id,
  ]);
});
