import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { designs, type Json, questions } from "../schema/index.ts";

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
  const [question] = await db
    .with(counted)
    .insert(questions)
    .values({ id: newId("q"), designId, kind, payload })
    .returning();
  return question!;
}

/**
 * Answer an open question and take it off the design's count. The first answer wins: null
 * when the question is not open any more, or is not this design's.
 */
export async function answerQuestion(
  db: Db,
  { designId, id, answer, userId }: { designId: string; id: string; answer: Json; userId: string },
): Promise<Question | null> {
  const answered = db.$with("answered").as(
    db
      .update(questions)
      .set({ status: "answered", answer, answeredByUserId: userId, answeredAt: sql`now()` })
      .where(
        and(eq(questions.id, id), eq(questions.designId, designId), eq(questions.status, "open")),
      )
      .returning(),
  );
  const counted = db.$with("counted").as(
    db
      .update(designs)
      .set({ needsYouCount: sql`greatest(${designs.needsYouCount} - 1, 0)` })
      .where(and(eq(designs.id, designId), sql`exists (select 1 from ${answered})`))
      .returning({ id: designs.id }),
  );
  const [question] = await db.with(answered, counted).select().from(answered);
  return question ?? null;
}

/** How many of a design's questions are waiting for an answer. */
export async function countOpenQuestions(db: Db, designId: string): Promise<number> {
  const [row] = await db
    .select({ open: count() })
    .from(questions)
    .where(and(eq(questions.designId, designId), eq(questions.status, "open")));
  return row?.open ?? 0;
}

/** A design's questions that are waiting for an answer, in the order they were asked. */
export function listOpenQuestions(db: Db, designId: string): Promise<Question[]> {
  return db
    .select()
    .from(questions)
    .where(and(eq(questions.designId, designId), eq(questions.status, "open")))
    .orderBy(questions.seq);
}
