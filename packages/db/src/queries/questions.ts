import { and, count, eq, inArray, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId } from "../ids.ts";
import { canvases, events, type Json, questions, repoSecrets } from "../schema/index.ts";
import { run } from "./run.ts";
import { scrubbed } from "./text.ts";

export type Question = typeof questions.$inferSelect;

/**
 * Raise something the agent needs a person for, under an id the caller chose (a runner derives
 * it from the tool call), so raising it again changes nothing. The canvas's `needs_you_count`
 * goes up in the same statement when the question is new, so the count clients watch never
 * disagrees with the questions for long enough to see. Answers where the question stands, and
 * whether this raised it.
 */
export async function createQuestion(
  db: Db,
  {
    canvasId,
    id = newId("q"),
    kind,
    payload,
  }: { canvasId: string; id?: string; kind: Question["kind"]; payload: Json },
): Promise<{ id: string; status: Question["status"]; raised: boolean }> {
  // A conflict takes the row as it stands, whoever raised it, even one raised by a statement
  // running at the same moment, which `do nothing` would hand back as nothing. Setting the id to
  // itself changes nothing; `xmax` is 0 only on a row this statement inserted.
  const raised = db.$with("raised").as(
    db
      .insert(questions)
      .values({ id, canvasId, kind, payload: scrubbed(payload) })
      .onConflictDoUpdate({
        target: [questions.canvasId, questions.id],
        set: { id: sql`${questions.id}` },
      })
      .returning({ status: questions.status, raised: sql<boolean>`xmax = 0`.as("raised") }),
  );
  const counted = db.$with("counted").as(
    db
      .update(canvases)
      // Relative, so two questions raised at once both count.
      .set({ needsYouCount: sql`${canvases.needsYouCount} + 1` })
      .where(and(eq(canvases.id, canvasId), sql`exists (select 1 from ${raised} where raised)`))
      .returning({ id: canvases.id }),
  );
  const [row] = await run(db.with(raised, counted).select().from(raised));
  return { id, ...row! };
}

/** One of a canvas's questions, or null. */
export async function getQuestion(
  db: Db,
  { canvasId, id }: { canvasId: string; id: string },
): Promise<Question | null> {
  const [question] = await run(
    db
      .select()
      .from(questions)
      .where(and(eq(questions.canvasId, canvasId), eq(questions.id, id))),
  );
  return question ?? null;
}

/**
 * Answer an open question, take it off the canvas's count, and add the `answer` event that
 * takes the answer to the agent, in one statement. The first answer wins: null, and nothing
 * written, when the question is not open any more, or is not this canvas's.
 *
 * The event carries the question as it was raised (`question: { kind, payload }`), so a runner
 * that no longer has it in mind can say again what was asked, and `answer`'s fields beside it.
 * The answer is stored in the clear in a row clients watch. A question of kind `secret` is not
 * answered here (null); `answerSecretQuestion` keeps its value out of this table.
 */
export async function answerQuestion(
  db: Db,
  {
    canvasId,
    id,
    answer,
    userId,
    posthogSessionId = null,
  }: {
    canvasId: string;
    id: string;
    answer: Json;
    userId: string;
    /** The PostHog session of the app that answered, if it said. */
    posthogSessionId?: string | null;
  },
): Promise<Question | null> {
  const answered = answering(db, {
    canvasId,
    id,
    answer: scrubbed(answer),
    userId,
    only: ne(questions.kind, "secret"),
  });
  const told = db.$with("told", { id: events.id }).as(sql`
    insert into ${events} (id, canvas_id, kind, priority, payload, user_id, posthog_session_id)
    select ${newId("evt")}, ${answered.canvasId}, 'answer', 'now',
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
      .with(answered, uncounted(db, canvasId, answered), told)
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
 * Null, and nothing written, when the question is not an open secret question of this canvas,
 * or the canvas is Scratch: secrets belong to a repo, and Scratch has none.
 */
export async function answerSecretQuestion(
  db: Db,
  input: {
    canvasId: string;
    id: string;
    name: string;
    encryptedValue: string;
    /** The plain value's length in UTF-8 bytes. */
    valueBytes: number;
    userId: string;
  },
): Promise<Question | null> {
  const { canvasId, id, name, encryptedValue, valueBytes, userId } = input;
  const inRepo = db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.id, canvasId), isNotNull(canvases.repoId)));
  const answered = answering(db, {
    canvasId,
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
            repoId: sql<string>`${canvases.repoId}`.as("repo_id"),
            name: sql<string>`${name}`.as("name"),
            encryptedValue: sql<string>`${encryptedValue}`.as("encrypted_value"),
            valueBytes: sql<number>`${valueBytes}::integer`.as("value_bytes"),
            updatedByUserId: sql<string>`${userId}`.as("updated_by_user_id"),
            createdAt: sql<Date>`now()`.as("created_at"),
            updatedAt: sql<Date>`now()`.as("updated_at"),
          })
          .from(canvases)
          .where(and(eq(canvases.id, canvasId), sql`exists (select 1 from ${answered})`)),
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
      .with(answered, uncounted(db, canvasId, answered), kept)
      .select()
      .from(answered),
  );
  return question ?? null;
}

/**
 * Close a canvas's open questions without an answer, and take them off its count: all of
 * them, or those in `ids`. For a run that was stopped, or a sandbox that was lost, with a
 * question still up that nobody can answer now. Answers how many were closed.
 */
export async function cancelQuestions(
  db: Db,
  { canvasId, ids }: { canvasId: string; ids?: string[] },
): Promise<number> {
  if (ids?.length === 0) return 0;
  const cancelled = db.$with("cancelled").as(
    db
      .update(questions)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(questions.canvasId, canvasId),
          eq(questions.status, "open"),
          ids ? inArray(questions.id, ids) : undefined,
        ),
      )
      .returning({ id: questions.id }),
  );
  const [row] = await run(
    db
      .with(cancelled, uncounted(db, canvasId, cancelled))
      .select({ closed: count() })
      .from(cancelled),
  );
  return row?.closed ?? 0;
}

/** How many of a canvas's questions are waiting for an answer. */
export async function countOpenQuestions(db: Db, canvasId: string): Promise<number> {
  const [row] = await run(
    db
      .select({ open: count() })
      .from(questions)
      .where(and(eq(questions.canvasId, canvasId), eq(questions.status, "open"))),
  );
  return row?.open ?? 0;
}

/** A canvas's questions that are waiting for an answer, in the order they were asked. */
export function listOpenQuestions(db: Db, canvasId: string): Promise<Question[]> {
  return run(
    db
      .select()
      .from(questions)
      .where(and(eq(questions.canvasId, canvasId), eq(questions.status, "open")))
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
          eq(questions.canvasId, input.canvasId),
          eq(questions.status, "open"),
          input.only,
        ),
      )
      .returning(),
  );
}

interface Answer {
  canvasId: string;
  id: string;
  answer: Json;
  userId: string;
  only: SQL;
}

/**
 * `with counted`: take the questions `closed` just closed off the canvas's count. It subtracts
 * what was closed, not what was asked for, so answering or cancelling twice counts once.
 */
function uncounted(db: Db, canvasId: string, closed: Parameters<Db["with"]>[number]) {
  return db.$with("counted").as(
    db
      .update(canvases)
      .set({
        needsYouCount: sql`greatest(${canvases.needsYouCount} - (select count(*) from ${closed}), 0)`,
      })
      .where(and(eq(canvases.id, canvasId), sql`exists (select 1 from ${closed})`))
      .returning({ id: canvases.id }),
  );
}
