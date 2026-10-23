import { encode } from "uqr";

/**
 * What the pairing code says: where this Mac is on the tailnet, and nothing
 * secret. The phone still has to be on the tailnet, signed in as the same
 * person, before this Mac answers it.
 */
export const pairUrl = (host: string) => `ponzu://pair?host=${encodeURIComponent(host)}&v=1`;

/**
 * A QR code as one SVG path in module units, a run of dark modules per
 * segment, and its side in modules. No quiet zone: the tile around it is one.
 */
export function qrPath(text: string): { size: number; d: string } {
  const { data, size } = encode(text, { ecc: "M", border: 0 });
  let d = "";
  data.forEach((row, y) => {
    for (let x = 0; x < size; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let n = 1;
      while (row[x + n]) n++;
      d += `M${x} ${y}h${n}v1h-${n}z`;
      x += n;
    }
  });
  return { size, d };
}
