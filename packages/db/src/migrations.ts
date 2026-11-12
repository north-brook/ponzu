import { fileURLToPath } from "node:url";

/** Where drizzle-kit writes the migrations and the migrators read them. */
export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
