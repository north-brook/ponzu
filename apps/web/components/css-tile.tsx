import type { CSSProperties } from "react";

const SEGMENTS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * A ponzu wheel for the "Just HTML and CSS" tile. `SLICE_CSS` turns the wheel while its segments
 * spring in one after another and pop back out; each segment carries its place in the ring as `--i`.
 */
export function CssTileVisual() {
  return (
    <svg viewBox="-60 -60 120 120" className="h-[128px] w-auto overflow-visible" aria-hidden="true">
      <circle r="57" fill="var(--rind)" />
      <circle r="51" fill="var(--pith)" />
      <g className="cit-wheel">
        {SEGMENTS.map((i) => (
          <path
            key={i}
            className="cit-seg"
            style={{ "--i": i } as CSSProperties}
            transform={`rotate(${i * 45})`}
            d="M0 -8L-12.9 -42.1A44 44 0 0 1 12.9 -42.1Z"
            fill="var(--flesh)"
            stroke="var(--flesh)"
            strokeWidth="5"
            strokeLinejoin="round"
          />
        ))}
      </g>
    </svg>
  );
}
