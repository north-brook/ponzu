import type { Live, LiveSnapshot } from "@ponzu/client";
import {
  createQueryClient,
  invalidateFromLive,
  type PonzuMutations,
  type PonzuQueries,
  ponzuMutations,
  ponzuQueries,
} from "@ponzu/client/query";
import { LiveProvider, useSessionState } from "@ponzu/client/react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  focusManager,
  onlineManager,
  type QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/react-query-persist-client";
import { addNetworkStateListener, type NetworkState } from "expo-network";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { backend } from "./backend";
import { config } from "./config";
import { buster, PERSIST_KEY, PERSIST_MAX_AGE, persistable } from "./persist";

/*
 * One signed-in person's client state: their QueryClient (made at sign-in, dropped at sign-out,
 * so nothing of one person reaches the next), its copy on disk (an allow-list, persist.ts), and
 * their `Live`. The providers stay mounted whoever is signed in, so the screens under them are
 * never remounted by a sign-in; only what they hand down changes.
 */

const persister = createAsyncStoragePersister({
  key: PERSIST_KEY,
  storage: AsyncStorage,
  throttleTime: 2_000,
});

/** Offline only when the phone says so; an unknown answer is not an outage. */
const reachable = (state: NetworkState) =>
  state.isConnected !== false && state.isInternetReachable !== false;

onlineManager.setEventListener((setOnline) => {
  const sub = addNetworkStateListener((state) => setOnline(reachable(state)));
  return () => sub.remove();
});

// The app in the foreground is the query client's focus.
focusManager.setEventListener((setFocused) => {
  const sub = AppState.addEventListener("change", (state) => setFocused(state === "active"));
  return () => sub.remove();
});

const CONNECTING = Object.freeze({ rows: undefined, status: "connecting" }) as LiveSnapshot<never>;

/** The `Live` while nobody is signed in: every query waits, and nothing is sent. */
const idleLive: Live = {
  subscribe: () => () => {},
  snapshot: () => CONNECTING,
  pause: () => {},
  resume: () => {},
  close: () => {},
};

export interface Cloud {
  /** Who this state is for; null while nobody is signed in. */
  userId: string | null;
  queryClient: QueryClient;
  live: Live;
  queries: PonzuQueries;
  mutations: PonzuMutations;
  /** The answers kept on disk are still being read back. */
  restoring: boolean;
  /** Forget this person's answers, here and on disk (signing out). */
  clear(): Promise<void>;
}

const CloudContext = createContext<Cloud | null>(null);

function makeCloud(userId: string | null) {
  const queryClient = createQueryClient();
  return {
    userId,
    queryClient,
    live: userId ? backend.makeLive() : idleLive,
    queries: ponzuQueries(backend.api),
    mutations: ponzuMutations(backend.api, queryClient),
  };
}

export function CloudProvider({ children }: { children: ReactNode }) {
  const state = useSessionState(backend.session);
  const userId = state.status === "signed_in" ? state.user.id : null;
  const made = useMemo(() => makeCloud(userId), [userId]);
  const [restoring, setRestoring] = useState(userId !== null);

  useEffect(() => {
    const { queryClient, live } = made;
    if (!made.userId) {
      return () => {
        live.close();
        queryClient.clear();
      };
    }
    const options = {
      queryClient,
      persister,
      maxAge: PERSIST_MAX_AGE,
      buster: buster(config().version, made.userId),
    };
    let on = true;
    let unsubscribe = () => {};
    setRestoring(true);
    // Saving starts only once the copy on disk is read, or an empty cache would overwrite it.
    persistQueryClientRestore(options)
      .catch(() => persister.removeClient())
      .finally(() => {
        if (!on) return;
        setRestoring(false);
        unsubscribe = persistQueryClientSubscribe({
          ...options,
          dehydrateOptions: {
            shouldDehydrateQuery: (query) =>
              query.state.status === "success" && persistable(query.queryKey),
          },
        });
      });
    const stopInvalidating = invalidateFromLive(queryClient, live);
    // In the background the sockets go; back in front, every query starts again whole.
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") live.resume();
      else if (next === "background") live.pause();
    });
    return () => {
      on = false;
      unsubscribe();
      stopInvalidating();
      appState.remove();
      live.close();
      // This person's answers go with them; the copy on disk stays for their next launch.
      queryClient.clear();
    };
  }, [made]);

  const cloud = useMemo<Cloud>(
    () => ({
      ...made,
      restoring: made.userId !== null && restoring,
      async clear() {
        made.queryClient.clear();
        await persister.removeClient();
      },
    }),
    [made, restoring],
  );

  return (
    <CloudContext.Provider value={cloud}>
      <QueryClientProvider client={made.queryClient}>
        <LiveProvider live={made.live}>{children}</LiveProvider>
      </QueryClientProvider>
    </CloudContext.Provider>
  );
}

/** The signed-in person's client state (or the idle one while nobody is). */
export function useCloud(): Cloud {
  const cloud = useContext(CloudContext);
  if (!cloud) throw new Error("useCloud needs a <CloudProvider> above it.");
  return cloud;
}
