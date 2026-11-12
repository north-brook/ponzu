import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useCallback } from "react";
import { backend } from "./backend";
import { DOC_CACHE_PATH, fileStorage } from "./files";
import { useCloud } from "./query";
import { DEVICE_KEY, keysToClear, signOut } from "./sign-out";
import { forgetWorkspaces } from "./workspace";

/** Signing out of this phone, every step in sign-out.ts's order. */
export function useSignOut(): () => Promise<void> {
  const cloud = useCloud();
  return useCallback(
    () =>
      signOut({
        readDeviceId: () => AsyncStorage.getItem(DEVICE_KEY),
        deleteDevice: (id) => backend.api.devices.remove(id),
        signOut: () => backend.session.signOut(),
        clearQueries: () => cloud.clear(),
        closeLive: () => cloud.live.close(),
        clearFiles: async () => {
          forgetWorkspaces();
          fileStorage(...DOC_CACHE_PATH).clear();
          await AsyncStorage.multiRemove(keysToClear(await AsyncStorage.getAllKeys()));
          await Image.clearDiskCache();
          await Image.clearMemoryCache();
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
