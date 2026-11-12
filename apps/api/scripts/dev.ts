// `bun run dev`: the API on this machine, against the Neon `dev` branch.
//
// It serves the same app the deployment does (src/index.ts), so it needs the same environment
// (.env.example). Bun reads apps/api/.env.local by itself. Some of it is filled in here so a
// development environment can be the handful of keys it already has:
//
//   DATABASE_URL            looked up from Neon by branch name when NEON_API_KEY and
//   NEON_REALTIME_URL       NEON_PROJECT_ID are set. Always the branch named "dev".
//   NEON_REALTIME_SECRET
//   GITHUB_APP_PRIVATE_KEY  read from the file GITHUB_APP_PRIVATE_KEY_PATH names.
//   PONZU_ASSETS_URL        https://assets.ponzu.cloud unless set.
//
// PORT picks the port (default 8787).
import { readFileSync } from "node:fs";
import { branchDatabaseUrl, branchRealtime } from "./neon.ts";

const { env } = process;

if (env.NEON_API_KEY && env.NEON_PROJECT_ID) {
  const project = { apiKey: env.NEON_API_KEY, projectId: env.NEON_PROJECT_ID };
  env.DATABASE_URL ||= await branchDatabaseUrl("dev", project);
  if (!env.NEON_REALTIME_URL || !env.NEON_REALTIME_SECRET) {
    const realtime = await branchRealtime("dev", project);
    env.NEON_REALTIME_URL = realtime.url;
    env.NEON_REALTIME_SECRET = realtime.secret;
  }
}
if (!env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_PRIVATE_KEY_PATH) {
  env.GITHUB_APP_PRIVATE_KEY = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
}
env.PONZU_ASSETS_URL ||= "https://assets.ponzu.cloud";

// Imported only now: the module reads the environment as it loads.
const { default: app } = await import("../src/index.ts");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(env.PORT ?? 8787),
  fetch: app.fetch,
});
console.log(`Ponzu API on ${server.url}v1/health`);
