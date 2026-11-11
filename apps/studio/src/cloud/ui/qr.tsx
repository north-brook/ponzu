import { encode } from "uqr";

/**
 * A QR code of `text` in `currentColor`, `module` px to a module so every edge lands on a whole
 * pixel: one path of the dark modules, a run per segment. ECC L keeps a short link to the
 * smallest grid, the densest a camera then has to read. No quiet zone; the tile around it is
 * one, and should be four modules wide.
 */
export function QrCode({ text, module, label }: { text: string; module: number; label: string }) {
  const { data, size: modules } = encode(text, { ecc: "L", border: 0 });
  let d = "";
  data.forEach((row, y) => {
    for (let x = 0; x < modules; ) {
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
  const size = modules * module;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      className="block"
    >
      <path d={d} fill="currentColor" />
    </svg>
  );
}
