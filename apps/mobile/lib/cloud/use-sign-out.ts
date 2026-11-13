import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useCallback } from "react";
import { drafts } from "../drafts";
import { setBadge } from "../push/native";
import { devices, stopPings } from "../push/pings";
import { backend } from "./backend";
import { DOC_CACHE_PATH, fileStorage } from "./files";
import { forgetFilters } from "./filter";
import { forgetNewCanvas } from "./new-canvas";
import { useCloud } from "./query";
import { keysToClear, signOut } from "./sign-out";
import { forgetWorkspaces } from "./workspace";

/** Signing out of this phone, every step in sign-out.ts's order. */
export function useSignOut(): () => Promise<void> {
  const cloud = useCloud();
  return useCallback(
    () =>
      signOut({
        // Only the device registered for the person signing out, and nothing registers it
        // again once it is gone (a heartbeat finding it deleted would). A registration under
        // way ends first and keeps its id, so the device it made is the one deleted.
        readDeviceId: async () => {
          if (!cloud.userId) return null;
          await stopPings(cloud.userId);
          return devices.read(cloud.userId);
        },
        deleteDevice: (id) => backend.api.devices.remove(id),
        signOut: () => backend.session.signOut(),
        clearQueries: () => cloud.clear(),
        closeLive: () => cloud.live.close(),
        clearFiles: async () => {
          forgetWorkspaces();
          forgetFilters();
          forgetNewCanvas();
          fileStorage(...DOC_CACHE_PATH).clear();
          // Unsent words: on disk they're `ponzu.drafts.*` keys, which go below.
          drafts.clear();
          await AsyncStorage.multiRemove(keysToClear(await AsyncStorage.getAllKeys()));
          await Image.clearDiskCache();
          await Image.clearMemoryCache();
          // The icon's count was theirs.
          await setBadge(0);
        },
        // Analytics arrive with their own slice (lib/analytics); there is no identity yet.
        resetAnalytics: () => {},
        toSignIn: () => {
          if (router.canDismiss()) router.dismissAll();
          router.replace("/sign-in");
        },
        onError: (step) => {
          if (__DEV__) console.warn(`[sign out] ${step} failed`);
        },
      }),
    [cloud],
  );
}
