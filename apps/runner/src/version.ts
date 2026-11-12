import { version } from "../package.json";

/** The runner's version, sent as `X-Ponzu-Client: runner/<version>`. */
export const VERSION: string = version;

/**
 * The bundle this runner was started from, by the first twelve hex of its sha256: what the API
 * put in `PONZU_RUNNER_BUNDLE` for this start (docs/cloud.md, "The runner bundle"). Null outside
 * a sandbox, or when the variable is not a hash.
 */
export function bundleName(env: Record<string, string | undefined> = process.env): string | null {
  const sha = env.PONZU_RUNNER_BUNDLE;
  return sha && /^[0-9a-f]{64}$/.test(sha) ? sha.slice(0, 12) : null;
}

/**
 * What the runner says it is on every call (`X-Ponzu-Client`): its version, and the bundle it
 * runs as build metadata (`runner/0.1.0+2de5aff8d903`), so the API, its logs and analytics can
 * say which build a turn ran on. The version alone outside a sandbox.
 */
export function runnerClient(bundle: string | null = bundleName()): string {
  return bundle ? `runner/${VERSION}+${bundle}` : `runner/${VERSION}`;
}
