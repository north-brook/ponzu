import { readFileSync } from "node:fs";
import { version } from "../package.json";

/** The runner's version, sent as `X-Ponzu-Client: runner/<version>`. */
export const VERSION: string = version;

/** Where the sandbox image keeps its record of what it was made from (image/provision.sh). */
export const IMAGE_RECORD = "/opt/ponzu/image.json";

/**
 * What the image's snapshots are named for: `image/recipe.ts`'s `SNAPSHOT_PREFIX` and the first
 * twelve hex of its inputs hash (`snapshotName`), which the image records as `inputs`. Kept here
 * rather than imported, since the recipe reads the checkout as it loads; a test holds them equal.
 */
export const SNAPSHOT_PREFIX = "ponzu-runner-";

/**
 * The image this runner runs in, by the name the API created its sandbox from: read from the
 * image's record, null outside an image or when the record says nothing usable.
 */
export function imageName(read: (path: string) => string = (path) => readFileSync(path, "utf8")) {
  try {
    const inputs = JSON.parse(read(IMAGE_RECORD))?.inputs;
    return typeof inputs === "string" && /^[0-9a-f]{12,}$/.test(inputs)
      ? `${SNAPSHOT_PREFIX}${inputs.slice(0, 12)}`
      : null;
  } catch {
    return null;
  }
}

/**
 * What the runner says it is on every call (`X-Ponzu-Client`): its version, and the image it
 * runs in as build metadata (`runner/0.1.0+ponzu-runner-2de5aff8d903`), so the API, its logs
 * and analytics can say which image a turn ran on. The version alone outside an image.
 */
export function runnerClient(image: string | null = imageName()): string {
  return image ? `runner/${VERSION}+${image}` : `runner/${VERSION}`;
}
