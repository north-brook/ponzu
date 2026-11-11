import type { Api } from "./api.ts";
import { type Clock, systemClock } from "./clock.ts";

/** One idea under the create composer. `id` is stable for the repo and the idea's place. */
export interface Idea {
  id: string;
  prompt: string;
}

/**
 * What the create page shows under the composer: the ideas, `"loading"` while they are being
 * made, or null for none (for now, or for good; nothing is ever an error on this screen).
 */
export type IdeasState = Idea[] | "loading" | null;

/**
 * How long to wait before each ask again while the API says `generating`. A generation takes
 * a few seconds, so the first asks are close together and the ideas show within a second or two
 * of being ready; then they spread out, and stop after about 45 seconds, the longest one
 * generation may run. Fourteen asks at most, almost always three or four.
 */
export const IDEAS_RETRY_MS = [
  1_000, 1_000, 1_500, 1_500, 2_000, 2_000, 2_000, 3_000, 3_000, 4_000, 5_000, 5_000, 6_000, 8_000,
] as const;

/**
 * A repo's ideas as they become known: `onChange` hears `"loading"` at once, then the ideas or
 * null. It asks again while they are being made, and gives up quietly on any failure. Returns
 * a way to stop (on leaving the page, or when the repo chip changes).
 */
export function watchRepoIdeas(
  api: Pick<Api, "repos">,
  repoId: string,
  onChange: (state: IdeasState) => void,
  { clock = systemClock }: { clock?: Clock } = {},
): () => void {
  let stopped = false;
  let cancel: (() => void) | null = null;
  const tell = (state: IdeasState) => {
    if (!stopped) onChange(state);
  };

  const ask = async (attempt: number) => {
    let answer: Awaited<ReturnType<Api["repos"]["ideas"]>>;
    try {
      answer = await api.repos.ideas(repoId);
    } catch {
      return tell(null);
    }
    if (stopped) return;
    if (answer.status === "ready" && answer.ideas.length > 0) {
      return tell(answer.ideas.map(({ prompt }, i) => ({ id: `${repoId}:${i}`, prompt })));
    }
    const wait = IDEAS_RETRY_MS[attempt];
    if (answer.status !== "generating" || wait === undefined) return tell(null);
    cancel = clock.schedule(() => void ask(attempt + 1), wait);
  };

  onChange("loading");
  void ask(0);
  return () => {
    stopped = true;
    cancel?.();
  };
}
