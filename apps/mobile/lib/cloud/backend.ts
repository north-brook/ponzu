import { createApi, createLive, createSession, type KeyValueStorage } from "@ponzu/client";
import { apiUrlOf, config } from "./config";
import { expoCrypto } from "./crypto";
import { keychain, phoneInstallId, prepareKeychain } from "./keychain";
import type { Backend } from "./types";

/*
 * Ponzu Cloud itself. A bundle built with PONZU_BACKEND=fake gets backend.fake.ts in this
 * module's place (metro.config.js), so the fake and its test code never ship in a real build.
 */

const cfg = config();

/** The Keychain, once an earlier install's session has been wiped from it. */
const storage: KeyValueStorage = {
  get: (key) => prepareKeychain().then(() => keychain.get(key)),
  set: (key, value) => prepareKeychain().then(() => keychain.set(key, value)),
  delete: (key) => prepareKeychain().then(() => keychain.delete(key)),
};

const session = createSession({
  // A production build that names no API fails here, at launch, rather than reaching dev.
  apiUrl: apiUrlOf(cfg),
  workosClientId: cfg.workosClientId,
  storage,
  client: { platform: "ios", version: cfg.version },
});
const api = createApi(session, { crypto: expoCrypto, linkScheme: cfg.scheme });

export const backend: Backend = {
  kind: "real",
  session,
  api,
  makeLive: () => createLive({ api }),
  authorizeUrl: null,
  prepare: prepareKeychain,
  installId: phoneInstallId,
};
