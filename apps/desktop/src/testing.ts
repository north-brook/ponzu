/*
 * For the desktop's tests only: builds as scripts/build.ts would bake them, from the repository's
 * own infra/environments.json, so a test's app talks to what a real build of it would. Nothing
 * in the app imports this.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Build, bakeEnvironment, type EnvironmentsFile } from "./config.ts";

export const ENVIRONMENTS_FILE = fileURLToPath(
  new URL("../../../infra/environments.json", import.meta.url),
);

export function environmentsFile(path = ENVIRONMENTS_FILE): EnvironmentsFile {
  return JSON.parse(readFileSync(path, "utf8")) as EnvironmentsFile;
}

/** Dev's environment, as Ponzu Dev bakes it today (and the release, until the cutover). */
export const DEV_ENVIRONMENT = bakeEnvironment(environmentsFile(), "dev");

export const TEST_COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A build of the release on dev, not a test build and reporting nowhere, with `over` on top. */
export function built(over: Partial<Build> = {}): Partial<Build> {
  return {
    test: false,
    variant: "release",
    posthog: { key: "", host: "", replay: "" },
    environment: DEV_ENVIRONMENT,
    commit: TEST_COMMIT,
    ...over,
  };
}
