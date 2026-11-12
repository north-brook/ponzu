// `@ponzu/client/react`: hooks over the client, for the studio and the phone alike. React is
// the only thing this entry adds; the rest of the package does not import it.
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { Api } from "./api.ts";
import type { Clock } from "./clock.ts";
import { type IdeasState, watchRepoIdeas } from "./ideas.ts";
import type { Live, LiveSnapshot } from "./live/live.ts";
import type { LiveArgs, LiveQueryName, LiveRows } from "./live/rows.ts";
import type { Session, SessionState } from "./session.ts";

const LiveContext = createContext<Live | null>(null);

/** Gives the components below it the app's one `Live`. */
export function LiveProvider({ live, children }: { live: Live; children?: ReactNode }) {
  return createElement(LiveContext.Provider, { value: live }, children);
}

/**
 * A live query's rows and status, kept current. The snapshot is the same object until
 * something changes, and every component reading the same query in one render sees the same
 * one. `args` may be a new object each render: the query is keyed by its values.
 */
export function useLiveQuery<Name extends LiveQueryName>(
  name: Name,
  args: LiveArgs[Name],
): LiveSnapshot<LiveRows[Name]> {
  const live = useContext(LiveContext);
  if (!live) throw new Error("useLiveQuery needs a <LiveProvider> above it.");
  const key = JSON.stringify(args, Object.keys(args).sort());
  const subscribe = useCallback(
    (changed: () => void) => live.subscribe(name, args, changed),
    // `args` is read through `key`: a new object with the same values is the same query.
    [live, name, key],
  );
  const snapshot = () => live.snapshot(name, args);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The ideas for the repo the create page has chosen, in the shape its `Ideas` takes:
 * `"loading"` while they are being made, the ideas once they are, null for none. Null too when
 * `repoId` is null (Scratch has no repo to read). Changing the repo swaps them.
 *
 *   const ideas = useRepoIdeas(api, repo?.id ?? null);
 */
export function useRepoIdeas(
  api: Pick<Api, "repos">,
  repoId: string | null,
  opts: { clock?: Clock } = {},
): IdeasState {
  const [known, setKnown] = useState<{ repoId: string; ideas: IdeasState } | null>(null);
  const { clock } = opts;
  useEffect(() => {
    if (repoId === null) return;
    return watchRepoIdeas(api, repoId, (ideas) => setKnown({ repoId, ideas }), { clock });
  }, [api, repoId, clock]);
  if (repoId === null) return null;
  // Until this repo's first answer: loading, never the last repo's ideas.
  return known?.repoId === repoId ? known.ideas : "loading";
}

/** Who is signed in, kept current. */
export function useSessionState(session: Session): SessionState {
  const subscribe = useCallback((changed: () => void) => session.subscribe(changed), [session]);
  const state = () => session.getState();
  return useSyncExternalStore(subscribe, state, state);
}
