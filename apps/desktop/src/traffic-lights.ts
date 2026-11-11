/**
 * Where the Mac's traffic lights go so they sit centred on the studio's 44px chrome, by the
 * macOS version (`process.getSystemVersion()`): since macOS 26 they are 14px tall, before it 12.
 */
export function trafficLights(systemVersion: string): { x: number; y: number } {
  const major = Number.parseInt(systemVersion, 10);
  const height = Number.isFinite(major) && major < 26 ? 12 : 14;
  return { x: 16, y: (44 - height) / 2 };
}
