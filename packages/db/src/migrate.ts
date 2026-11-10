// Apply the checked-in migrations to the database at DATABASE_URL: `bun run db:migrate`.
// Give it Neon's direct connection string, not the pooled one. It runs over HTTP, applies
// whatever is pending in one transaction, and does nothing when nothing is.
import { migrate } from "drizzle-orm/neon-http/migrator";
import { createDb } from "./client.ts";
import { migrationsFolder } from "./migrations.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const started = performance.now();
await migrate(createDb(url), { migrationsFolder });
console.log(`Migrations applied in ${Math.round(performance.now() - started)} ms.`);
