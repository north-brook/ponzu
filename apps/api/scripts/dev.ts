// `bun run dev`: the API on this machine, against the Neon `dev` branch.
//
// It serves the same app the deployment does (src/index.ts), so it needs the same environment
// (.env.example). Bun reads apps/api/.env.local by itself. Two things are filled in here so a
// development environment can be the handful of keys it already has:
//
//   DATABASE_URL            looked up from Neon by branch name when NEON_API_KEY and
//                           NEON_PROJECT_ID are set. Always the branch named "dev".
//   GITHUB_APP_PRIVATE_KEY  read from the file GITHUB_APP_PRIVATE_KEY_PATH names.
//
// PORT picks the port (default 8787).
import { readFileSync } from "node:fs";
import { branchDatabaseUrl } from "./neon.ts";

const { env } = process;

if (!env.DATABASE_URL && env.NEON_API_KEY && env.NEON_PROJECT_ID) {
  env.DATABASE_URL = await branchDatabaseUrl("dev", {
    apiKey: env.NEON_API_KEY,
    projectId: env.NEON_PROJECT_ID,
  });
}
if (!env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_PRIVATE_KEY_PATH) {
  env.GITHUB_APP_PRIVATE_KEY = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
}

// Imported only now: the module reads the environment as it loads.
const { default: app } = await import("../src/index.ts");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(env.PORT ?? 8787),
  fetch: app.fetch,
});
console.log(`Ponzu API on ${server.url}v1/health`);
