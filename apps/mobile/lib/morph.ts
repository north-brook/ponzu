import { EASE_OUT } from "./tokens";

/**
 * The comment sheet's voice ⇄ typing switch, timed as the design's motion
 * study (Flow › 8 ⇄ 7) has it. One clock runs from 0 (typing) to 1 (voice)
 * in `SWITCH_MS`, linearly; each part of the sheet moves over its own stretch
 * of it with the design's ease, and the stretches differ by direction: going
 * to voice, the field fades before the waveform grows in; coming back, the
 * waveform is gone before the field returns. Worklets, so the UI thread reads
 * them every frame; pure, so tests run them.
 */
export const SWITCH_MS = 600;

/** A part's stretch of the clock: going to voice, and coming back to typing. */
export interface Stretch {
  toVoice: readonly [number, number];
  toType: readonly [number, number];
}

/** The study's keyframes (13%→23% one way, 57%→67% the other, of a 6s loop), as stretches of 0..1. */
export const PARTS = {
  /** The sheet's shape: corners, insets, padding, its gaps. */
  sheet: { toVoice: [0, 1], toType: [0, 1] },
  /** The text field: fades and narrows (scaleX 0.96). */
  field: { toVoice: [0, 0.6], toType: [0, 0.6] },
  /** The waveform: grows in from scaleY 0.2. */
  wave: { toVoice: [0.2, 1], toType: [0.4, 1] },
  /** "Listening…" above the row. */
  listen: { toVoice: [0.2, 1], toType: [0.4, 1] },
  /** The mute button, from the left. */
  mute: { toVoice: [0.2, 1], toType: [0.4, 1] },
  /** The action button's mic, turning away. */
  mic: { toVoice: [0, 0.5], toType: [0, 0.5] },
  /** The action button's keyboard, turning in. */
  keys: { toVoice: [0.2, 0.8], toType: [0.3, 0.8] },
} as const satisfies Record<string, Stretch>;

/**
 * `cubic-bezier(0.2, 0.8, 0.2, 1)`, the design's `--ease-out`. Defined before
 * `phase`: a worklet captures what it calls when it's defined.
 */
export function ease(x: number): number {
  "worklet";
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = EASE_OUT;
  const bx = (s: number) => 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3;
  const by = (s: number) => 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
  // The curve's parameter for x, by bisection: monotonic, and exact enough in 20 steps.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/**
 * How far a part is toward voice (0 typing, 1 voice) at clock `t`, given
 * which way the switch runs. Each stretch eases in time order, as CSS
 * keyframes do: going back to typing, the ease runs from the voice end.
 */
export function phase(t: number, toVoice: boolean, part: Stretch): number {
  "worklet";
  const [a, b] = toVoice ? part.toVoice : part.toType;
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return toVoice ? ease(u) : 1 - ease(1 - u);
}
