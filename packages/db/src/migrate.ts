// Apply the checked-in migrations to the database at DATABASE_URL: `bun run db:migrate`.
// Give it a direct connection string (for Neon, not the pooled one).
//
// It runs over one real connection, and every pending migration goes in inside a single
// transaction: if a statement fails, or the connection drops part way, the database is left
// exactly as it was. Neon's HTTP driver cannot do that. Each statement there is its own
// request and its own commit, and a failure half way leaves tables with no record of the
// migration that made them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { migrationsFolder } from "./migrations.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const started = performance.now();
try {
  await migrate(drizzle({ client }), { migrationsFolder });

  // Drizzle applies only what is newer than the newest migration already applied. One written
  // earlier on another branch and merged later is older than that, and would be passed over
  // without a word here, while every test, on a fresh database, applies it.
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const { rows } = await client.query<{ applied: number }>(
    "select count(*)::int as applied from drizzle.__drizzle_migrations",
  );
  const applied = rows[0]?.applied ?? 0;
  if (applied !== journal.entries.length) {
    console.error(
      `The database has ${applied} migrations applied and the journal lists ${journal.entries.length}. ` +
        "One was skipped: it is older than the newest one applied. Regenerate it so that it comes last.",
    );
    process.exitCode = 1;
  } else {
    const latest = journal.entries.at(-1)?.tag ?? "none";
    console.log(
      `Migrations are up to date (${applied} applied, latest ${latest}) in ${Math.round(performance.now() - started)} ms.`,
    );
  }
} finally {
  await client.end();
}
