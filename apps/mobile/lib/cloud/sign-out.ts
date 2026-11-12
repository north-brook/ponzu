/*
 * Signing out (docs/mobile.md, "Signing out"), in this order, each step tried whatever the one
 * before it did, so a phone offline or an API that won't answer still ends signed out here:
 *
 * 1. This phone's device row, so pings stop (its id is kept at DEVICE_KEY once pings register).
 * 2. The session, at the API and in the Keychain.
 * 3. The person's cached answers, in memory and on disk.
 * 4. Their live queries.
 * 5. What else the phone kept of them: the offline canvases, every `ponzu.*` key but the ping
 *    ask's, and the cached images.
 * 6. Analytics' identity.
 * 7. The sign-in screen.
 */

/** Where this phone's device id is kept once pings register it. */
export const DEVICE_KEY = "ponzu.device";
/** Kept across sign-outs: when the phone last asked about pings is about the phone. */
export const KEPT_KEYS: readonly string[] = ["ponzu.pingAsk"];

export interface SignOutDeps {
  readDeviceId(): Promise<string | null>;
  deleteDevice(id: string): Promise<unknown>;
  signOut(): Promise<void>;
  clearQueries(): Promise<void> | void;
  closeLive(): void;
  clearFiles(): Promise<void> | void;
  resetAnalytics(): void;
  toSignIn(): void;
  /** Hears each step that failed, by name; it is never shown. */
  onError?(step: string, error: unknown): void;
}

export const SIGN_OUT_STEPS = [
  "device",
  "session",
  "queries",
  "live",
  "files",
  "analytics",
  "route",
] as const;

export async function signOut(deps: SignOutDeps): Promise<void> {
  const step = async (name: (typeof SIGN_OUT_STEPS)[number], run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      deps.onError?.(name, error);
    }
  };
  await step("device", async () => {
    const id = await deps.readDeviceId();
    if (id) await deps.deleteDevice(id);
  });
  await step("session", () => deps.signOut());
  await step("queries", () => deps.clearQueries());
  await step("live", () => deps.closeLive());
  await step("files", () => deps.clearFiles());
  await step("analytics", () => deps.resetAnalytics());
  await step("route", () => deps.toSignIn());
}

/** The AsyncStorage keys signing out removes: every `ponzu.*` one but those kept. */
export function keysToClear(keys: readonly string[]): string[] {
  return keys.filter((key) => key.startsWith("ponzu.") && !KEPT_KEYS.includes(key));
}
