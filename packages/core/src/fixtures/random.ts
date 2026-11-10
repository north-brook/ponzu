/** A seeded random source for tests: the same seed gives the same run, so a failure repeats. */
export interface Random {
  /** From 0 up to, not including, 1. */
  next(): number;
  /** A whole number from 0 up to, not including, `n`. */
  int(n: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
}

/** Mulberry32. */
export function random(seed: number): Random {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, chance: (p) => next() < p, pick: (items) => items[int(items.length)]! };
}
