import { and, count, eq, inArray, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { designs, type Json, questions, repoSecrets } from "../schema/index.ts";
import { run } from "./run.ts";
import { scrubbed } from "./text.ts";

export type Question = typeof questions.$inferSelect;

/**
 * Raise something the agent needs a person for. The design's `needs_you_count` goes up in the
 * same statement, so the count clients watch never disagrees with the questions for long
 * enough to see.
 */
export async function createQuestion(
  db: Db,
  { designId, kind, payload }: { designId: string; kind: Question["kind"]; payload: Json },
): Promise<Question> {
  const counted = db.$with("counted").as(
    db
      .update(designs)
      // Relative, so two questions raised at once both count.
      .set({ needsYouCount: sql`${designs.needsYouCount} + 1` })
      .where(eq(designs.id, designId))
      .returning({ id: designs.id }),
  );
  const [question] = await run(
    db
      .with(counted)
      .insert(questions)
      .values({ id: newId("q"), designId, kind, payload: scrubbed(payload) })
      .returning(),
  );
  return question!;
}

/**
 * Answer an open question and take it off the design's count. The first answer wins: null
 * when the question is not open any more, or is not this design's.
 *
 * The answer is stored in the clear in a row clients watch. A question of kind `secret` is
 * not answered here (null); `answerSecretQuestion` keeps its value out of this table.
 */
export async function answerQuestion(
  db: Db,
  { designId, id, answer, userId }: { designId: string; id: string; answer: Json; userId: string },
): Promise<Question | null> {
  const answered = answering(db, {
    designId,
    id,
    answer: scrubbed(answer),
    userId,
    only: ne(questions.kind, "secret"),
  });
  const [question] = await run(
    db
      .with(answered, uncounted(db, designId, answered))
      .select()
      .from(answered),
  );
  return question ?? null;
}

/**
 * Answer an open `secret` question: keep the value, already encrypted by the caller, as one of
 * the repo's secrets, and record on the question only which secret was given. One statement,
 * so the question is not closed without the secret being kept.
 *
 * Null, and nothing written, when the question is not an open secret question of this design,
 * or the design is Scratch: secrets belong to a repo, and Scratch has none.
 */
export async function answerSecretQuestion(
  db: Db,
  input: { designId: string; id: string; name: string; encryptedValue: string; userId: string },
): Promise<Question | null> {
  const { designId, id, name, encryptedValue, userId } = input;
  const inRepo = db
    .select({ id: designs.id })
    .from(designs)
    .where(and(eq(designs.id, designId), isNotNull(designs.repoId)));
  const answered = answering(db, {
    designId,
    id,
    answer: { name },
    userId,
    only: and(eq(questions.kind, "secret"), sql`exists (${inRepo})`)!,
  });
  const kept = db.$with("kept").as(
    db
      .insert(repoSecrets)
      .select(
        db
          .select({
            repoId: sql<string>`${designs.repoId}`.as("repo_id"),
            name: sql<string>`${name}`.as("name"),
            encryptedValue: sql<string>`${encryptedValue}`.as("encrypted_value"),
            updatedByUserId: sql<string>`${userId}`.as("updated_by_user_id"),
            createdAt: sql<Date>`now()`.as("created_at"),
            updatedAt: sql<Date>`now()`.as("updated_at"),
          })
          .from(designs)
          .where(and(eq(designs.id, designId), sql`exists (select 1 from ${answered})`)),
      )
      .onConflictDoUpdate({
        target: [repoSecrets.repoId, repoSecrets.name],
        set: {
          encryptedValue: sql`excluded.encrypted_value`,
          updatedByUserId: sql`excluded.updated_by_user_id`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ name: repoSecrets.name }),
  );
  const [question] = await run(
    db
      .with(answered, uncounted(db, designId, answered), kept)
      .select()
      .from(answered),
  );
  return question ?? null;
}

/**
 * Close a design's open questions without an answer, and take them off its count: all of
 * them, or those in `ids`. For a run that was stopped, or a sandbox that was lost, with a
 * question still up that nobody can answer now. Answers how many were closed.
 */
export async function cancelQuestions(
  db: Db,
  { designId, ids }: { designId: string; ids?: string[] },
): Promise<number> {
  if (ids?.length === 0) return 0;
  const cancelled = db.$with("cancelled").as(
    db
      .update(questions)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(questions.designId, designId),
          eq(questions.status, "open"),
          ids ? inArray(questions.id, ids) : undefined,
        ),
      )
      .returning({ id: questions.id }),
  );
  const [row] = await run(
    db
      .with(cancelled, uncounted(db, designId, cancelled))
      .select({ closed: count() })
      .from(cancelled),
  );
  return row?.closed ?? 0;
}

/** How many of a design's questions are waiting for an answer. */
export async function countOpenQuestions(db: Db, designId: string): Promise<number> {
  const [row] = await run(
    db
      .select({ open: count() })
      .from(questions)
      .where(and(eq(questions.designId, designId), eq(questions.status, "open"))),
  );
  return row?.open ?? 0;
}

/** A design's questions that are waiting for an answer, in the order they were asked. */
export function listOpenQuestions(db: Db, designId: string): Promise<Question[]> {
  return run(
    db
      .select()
      .from(questions)
      .where(and(eq(questions.designId, designId), eq(questions.status, "open")))
      .orderBy(questions.seq),
  );
}

/** `with answered`: the update that answers one open question, if `only` allows it. */
function answering(db: Db, input: Answer) {
  return db.$with("answered").as(
    db
      .update(questions)
      .set({
        status: "answered",
        answer: input.answer,
        answeredByUserId: input.userId,
        answeredAt: sql`now()`,
      })
      .where(
        and(
          eq(questions.id, input.id),
          eq(questions.designId, input.designId),
          eq(questions.status, "open"),
          input.only,
        ),
      )
      .returning(),
  );
}

interface Answer {
  designId: string;
  id: string;
  answer: Json;
  userId: string;
  only: SQL;
}

/**
 * `with counted`: take the questions `closed` just closed off the design's count. It subtracts
 * what was closed, not what was asked for, so answering or cancelling twice counts once.
 */
function uncounted(db: Db, designId: string, closed: Parameters<Db["with"]>[number]) {
  return db.$with("counted").as(
    db
      .update(designs)
      .set({
        needsYouCount: sql`greatest(${designs.needsYouCount} - (select count(*) from ${closed}), 0)`,
      })
      .where(and(eq(designs.id, designId), sql`exists (select 1 from ${closed})`))
      .returning({ id: designs.id }),
  );
}
