import * as Crypto from "expo-crypto";
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { chunkedStorage, type InstallMarker, installId, wipeAfterReinstall } from "./storage";

/*
 * The Keychain as the app uses it: expo-secure-store under one service, readable after the
 * phone's first unlock (so a push handled in the background can read the session) and never
 * restored onto another device. The rules (chunks, the reinstall wipe, the install id) are in
 * storage.ts, where tests reach them.
 */

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: "design.ponzu.session",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const keychain = chunkedStorage({
  getItemAsync: (key) => SecureStore.getItemAsync(key, OPTIONS),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
});

/** In the app's documents, which go when the app is deleted, unlike the Keychain. */
const marker: InstallMarker = {
  exists: () => new File(Paths.document, ".ponzu-installed").exists,
  create: () => {
    const file = new File(Paths.document, ".ponzu-installed");
    if (!file.exists) file.create();
  },
};

let ready: Promise<void> | null = null;

/** Before the session first reads the Keychain: forget a session an earlier install left. */
export function prepareKeychain(): Promise<void> {
  ready ??= wipeAfterReinstall(keychain, marker).then(() => undefined);
  return ready;
}

/** This phone's install id (docs/mobile.md, "The Keychain"). */
export function phoneInstallId(): Promise<string> {
  return prepareKeychain().then(() => installId(keychain, Crypto.randomUUID));
}
