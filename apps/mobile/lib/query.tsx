import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { focusManager, onlineManager, QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { addNetworkStateListener, type NetworkState } from "expo-network";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import { PROTOCOL } from "./mac";
import { PERSIST_MAX_AGE, persistable } from "./mac-queries";
import { VERSION } from "./ua";

/**
 * The phone's one cache of what it asked its Macs (see mac-queries.ts for the
 * keys). Each Mac's info and catalog are kept on disk, so the app opens onto
 * the last list and an asleep Mac keeps its designs. Live state (who answers,
 * an open design's socket) lives in its own stores.
 *
 * Requests go out whatever iOS says of the network (`networkMode: "always"`):
 * a Mac on the tailnet or the same Wi-Fi answers without the internet, and
 * reach.ts decides who answered.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { gcTime: PERSIST_MAX_AGE, networkMode: "always", retry: false },
    mutations: { networkMode: "always", retry: false },
  },
});

// A Mac's catalog runs to hundreds of KB, and patches come in bursts: written at most every 2s.
const persister = createAsyncStoragePersister({
  key: "ponzu.queries",
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

export function QueryProvider({ children }: { children: ReactNode }) {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE,
        // A new version or protocol may read a catalog differently: start from the Macs.
        buster: `${VERSION}:${PROTOCOL}`,
        dehydrateOptions: { shouldDehydrateQuery: persistable },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
