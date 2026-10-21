import { SLICE, SLICE_STROKE } from "@ponzu/react/slice";
import type { CSSProperties } from "react";

/**
 * The slice for the "Just HTML and CSS" tile. `SLICE_CSS` blooms its six segments in one after
 * another and turns them back out; each segment carries its place in the ring as `--i`.
 */
export function CssTileVisual() {
  return (
    <svg viewBox="0 0 64 64" className="h-[128px] w-auto overflow-visible" aria-hidden="true">
      <g fill="var(--yuzu)" stroke="var(--yuzu)" strokeWidth={SLICE_STROKE} strokeLinejoin="round">
        {SLICE.map((d, i) => (
          <path key={d} className="cit-seg" style={{ "--i": i } as CSSProperties} d={d} />
        ))}
      </g>
    </svg>
  );
}
