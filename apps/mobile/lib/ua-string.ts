/**
 * The User-Agent the phone sends on every request and socket. The server
 * tells the phone from a browser by it (`isPhone` in
 * packages/server/src/serve.ts), so it must start `Ponzu-iOS/<version>`.
 * Kept apart from ua.ts so it runs without React Native.
 */
export function userAgent(version: string, os: string | number): string {
  return `Ponzu-iOS/${version} (iPhone; iOS ${os})`;
}
