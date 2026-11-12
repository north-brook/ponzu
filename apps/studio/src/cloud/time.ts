import { createContext, useContext } from "react";

// How times are written is shared with the phone; only where "now" comes from is the studio's.
export { ago, clock, duration } from "@ponzu/client/model/time";

/**
 * The time a component measures ages from. The app leaves it to the clock; the gallery and tests
 * pin it, so "2 h" reads the same on every run.
 */
export const NowContext = createContext<(() => number) | null>(null);

export function useNow(): number {
  const now = useContext(NowContext);
  return now ? now() : Date.now();
}
