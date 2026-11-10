import { defineConfig } from "drizzle-kit";

// `generate` only reads the schema. Migrations are applied by src/migrate.ts, never by drizzle-kit.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
