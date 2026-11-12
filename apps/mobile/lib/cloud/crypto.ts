import type { Randomness } from "@ponzu/client";
import * as Crypto from "expo-crypto";

/**
 * The little of Web Crypto `@ponzu/client` needs (PKCE at sign-in, an upload's checksum), from
 * expo-crypto: Hermes has no `crypto.subtle`.
 */
export const expoCrypto: Randomness = {
  getRandomValues: (bytes) => Crypto.getRandomValues(bytes),
  subtle: {
    digest: (_algorithm, data) =>
      Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data as Uint8Array<ArrayBuffer>),
  },
};
