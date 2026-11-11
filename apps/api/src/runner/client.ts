/*
 * What a runner says it is, in the `X-Ponzu-Client` header it sends on every call: its version
 * and, since the image began saying so, the image it runs in, as semver build metadata
 * (`runner/0.1.0+ponzu-runner-2de5aff8d903`). An older runner says only `runner/0.1.0`, and its
 * image is not known from what it says (docs/cloud.md, "How images roll out").
 */

/** The image a runner says it runs in, or null when it does not say. */
export function runnerImage(client: string | null | undefined): string | null {
  if (!client?.startsWith("runner/")) return null;
  const plus = client.indexOf("+");
  if (plus < 0) return null;
  const image = client.slice(plus + 1);
  return /^[a-z0-9-]+$/.test(image) ? image : null;
}
