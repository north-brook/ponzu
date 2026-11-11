// Before electron-builder packs the app: source maps uploaded to PostHog when this build has
// the CLI's credentials, and removed from what ships either way (scripts/sourcemaps.ts).
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async () => {
  const result = spawnSync("bun", [join(__dirname, "sourcemaps.ts")], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`scripts/sourcemaps.ts exited ${result.status}`);
};
