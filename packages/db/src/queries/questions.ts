import { and, count, eq, inArray, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { designs, events, type Json, questions, repoSecrets } from "../schema/index.ts";
import { run } from "./run.ts";
import { scrubbed } from "./text.ts";

export type Question = typeof questions.$inferSelect;

/**
 * Raise something the agent needs a person for, under an id the caller chose (a runner derives
 * it from the tool call), so raising it again changes nothing. The design's `needs_you_count`
 * goes up in the same statement when the question is new, so the count clients watch never
 * disagrees with the questions for long enough to see. Answers where the question stands, and
 * whether this raised it.
 */
export async function createQuestion(
  db: Db,
  {
    designId,
    id = newId("q"),
    kind,
    payload,
  }: { designId: string; id?: string; kind: Question["kind"]; payload: Json },
): Promise<{ id: string; status: Question["status"]; raised: boolean }> {
  // A conflict takes the row as it stands, whoever raised it, even one raised by a statement
  // running at the same moment, which `do nothing` would hand back as nothing. Setting the id to
  // itself changes nothing; `xmax` is 0 only on a row this statement inserted.
  const raised = db.$with("raised").as(
    db
      .insert(questions)
      .values({ id, designId, kind, payload: scrubbed(payload) })
      .onConflictDoUpdate({
        target: [questions.designId, questions.id],
        set: { id: sql`${questions.id}` },
      })
      .returning({ status: questions.status, raised: sql<boolean>`xmax = 0`.as("raised") }),
  );
  const counted = db.$with("counted").as(
    db
      .update(designs)
      // Relative, so two questions raised at once both count.
      .set({ needsYouCount: sql`${designs.needsYouCount} + 1` })
      .where(and(eq(designs.id, designId), sql`exists (select 1 from ${raised} where raised)`))
      .returning({ id: designs.id }),
  );
  const [row] = await run(db.with(raised, counted).select().from(raised));
  return { id, ...row! };
}

/** One of a design's questions, or null. */
export async function getQuestion(
  db: Db,
  { designId, id }: { designId: string; id: string },
): Promise<Question | null> {
  const [question] = await run(
    db
      .select()
      .from(questions)
      .where(and(eq(questions.designId, designId), eq(questions.id, id))),
  );
  return question ?? null;
}

/**
 * Answer an open question, take it off the design's count, and add the `answer` event that
 * takes the answer to the agent, in one statement. The first answer wins: null, and nothing
 * written, when the question is not open any more, or is not this design's.
 *
 * The event carries the question as it was raised (`question: { kind, payload }`), so a runner
 * that no longer has it in mind can say again what was asked, and `answer`'s fields beside it.
 * The answer is stored in the clear in a row clients watch. A question of kind `secret` is not
 * answered here (null); `answerSecretQuestion` keeps its value out of this table.
 */
export async function answerQuestion(
  db: Db,
  {
    designId,
    id,
    answer,
    userId,
    posthogSessionId = null,
  }: {
    designId: string;
    id: string;
    answer: Json;
    userId: string;
    /** The PostHog session of the app that answered, if it said. */
    posthogSessionId?: string | null;
  },
): Promise<Question | null> {
  const answered = answering(db, {
    designId,
    id,
    answer: scrubbed(answer),
    userId,
    only: ne(questions.kind, "secret"),
  });
  const told = db.$with("told", { id: events.id }).as(sql`
    insert into ${events} (id, design_id, kind, priority, payload, user_id, posthog_session_id)
    select ${newId("evt")}, ${answered.designId}, 'answer', 'now',
           jsonb_build_object(
             'questionId', ${answered.id},
             'question', jsonb_build_object('kind', ${answered.kind}, 'payload', ${answered.payload})
           ) || ${answered.answer},
           ${userId}, ${posthogSessionId}
      from ${answered}
    returning id
  `);
  const [question] = await run(
    db
      .with(answered, uncounted(db, designId, answered), told)
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
  input: {
    designId: string;
    id: string;
    name: string;
    encryptedValue: string;
    /** The plain value's length in UTF-8 bytes. */
    valueBytes: number;
    userId: string;
  },
): Promise<Question | null> {
  const { designId, id, name, encryptedValue, valueBytes, userId } = input;
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
            valueBytes: sql<number>`${valueBytes}::integer`.as("value_bytes"),
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
          valueBytes: sql`excluded.value_bytes`,
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
