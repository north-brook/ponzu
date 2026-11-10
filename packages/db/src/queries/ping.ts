import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { run } from "./run.ts";

/** Whether the database answers at all: the smallest statement there is. */
export async function pingDb(db: Db): Promise<void> {
  await run(db.execute(sql`select 1`));
}
