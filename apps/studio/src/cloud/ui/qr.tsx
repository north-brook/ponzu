import { encode } from "uqr";

/**
 * A QR code of `text`, `size` px square, in `currentColor`: one path of the dark modules, a run
 * per segment. No quiet zone; the tile around it is one.
 */
export function QrCode({ text, size, label }: { text: string; size: number; label: string }) {
  const { data, size: modules } = encode(text, { ecc: "M", border: 0 });
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
