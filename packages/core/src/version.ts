/** Bumped when the server draws pictures or films loops differently, so old ones aren't used. */
export const DRAW_VERSION = 4;

/**
 * Which version of a board a picture shows, as a short name: how pictures are
 * drawn, its HTML and the design's tokens, hashed (FNV-1a). The canvas names
 * the picture it wants by this, and the server says which version it drew, so
 * a picture is only kept under the URL of the content it shows.
 */
export function boardVersion(html: string, tokens: string): string {
  const s = `${DRAW_VERSION}\n${html}\n${tokens}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
