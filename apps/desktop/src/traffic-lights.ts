/** How tall the studio's chrome is (apps/studio/src/cloud/window/app-window.tsx, its header). */
export const CHROME = 38;

/**
 * Where the Mac's traffic lights go so they sit centred on the studio's chrome, by the macOS
 * version (`process.getSystemVersion()`): since macOS 26 they are 14px tall, before it 12.
 */
export function trafficLights(systemVersion: string): { x: number; y: number } {
  const major = Number.parseInt(systemVersion, 10);
  const height = Number.isFinite(major) && major < 26 ? 12 : 14;
  return { x: 16, y: (CHROME - height) / 2 };
}
