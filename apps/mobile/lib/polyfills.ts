/**
 * What `@ponzu/core` needs from the runtime that Hermes doesn't have:
 * `crypto.getRandomValues` for node ids, and `structuredClone` for ops.
 * Expo installs a `structuredClone` of its own on native; this fills it in
 * only where it is still missing. The entry imports this module first.
 */
import "react-native-get-random-values";
import structuredClonePolyfill from "@ungap/structured-clone";

if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = structuredClonePolyfill as typeof structuredClone;
}
