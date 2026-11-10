import { NeonDbError } from "@neondatabase/serverless";
import { DrizzleQueryError } from "drizzle-orm/errors";

/**
 * A statement that failed. The message is what Postgres said, which names the constraint that
 * was broken; `cause` is the driver's own error, with its code. Unlike Drizzle's error it
 * does not list the statement's parameters.
 */
export class QueryError extends Error {
  /** The statement's text, with placeholders where its parameters were. */
  readonly statement: string;
  /**
   * True when Postgres never answered: Neon could not be reached, ran out of the time
   * `createDb` gave it, or failed in front of the database. Whether the statement took effect
   * is then unknown. False when Postgres refused the statement, which sending it again will
   * not mend. Only Neon's HTTP driver is told apart this way.
   */
  readonly unavailable: boolean;

  constructor(statement: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : "The query failed.", { cause });
    this.name = "QueryError";
    this.statement = statement;
    // A refusal from Postgres carries a SQLSTATE. A request that never reached it has none.
    this.unavailable = cause instanceof NeonDbError && cause.code === undefined;
  }
}

/**
 * Await a query. Every query in this package goes through here, because Drizzle's own error
 * puts each parameter into its message: an op batch, a thread payload or a token would land
 * wherever the caller logs errors. (Postgres itself quotes a value only when it cannot read
 * it as the type asked for, like text sent where a number belongs.)
 */
export async function run<T>(query: PromiseLike<T>): Promise<T> {
  try {
    return await query;
  } catch (error) {
    if (error instanceof DrizzleQueryError) throw new QueryError(error.query, error.cause);
    throw error;
  }
}
