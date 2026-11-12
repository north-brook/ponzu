/*
 * What a runner says it is, in the `X-Ponzu-Client` header it sends on every call: its version
 * and the bundle it was started from (the first twelve hex of its sha256), as semver build
 * metadata (`runner/0.1.0+2de5aff8d903`). A runner started outside a sandbox says only
 * `runner/0.1.0` (docs/cloud.md, "The runner bundle").
 */

/** The bundle a runner says it runs, or null when it does not say. */
export function runnerBundle(client: string | null | undefined): string | null {
  if (!client?.startsWith("runner/")) return null;
  const plus = client.indexOf("+");
  if (plus < 0) return null;
  const bundle = client.slice(plus + 1);
  return /^[0-9a-f]{12}$/.test(bundle) ? bundle : null;
}
