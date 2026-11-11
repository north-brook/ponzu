import { expect, test } from "bun:test";
import type { SessionState } from "@ponzu/client";
import { linkSchemeOf, signedInCache } from "./desktop-host.ts";

test("the API links back to Ponzu or Ponzu Dev; Ponzu Local, with no scheme, says it takes none", () => {
  expect(linkSchemeOf("ponzu")).toBe("ponzu");
  expect(linkSchemeOf("ponzu-dev")).toBe("ponzu-dev");
  // Never Ponzu's for a build that isn't Ponzu: that was the setup page opening ponzu:// for a
  // development build on a Mac.
  for (const scheme of ["", undefined, "ponzu-preview", "javascript"]) {
    expect(linkSchemeOf(scheme)).toBe("none");
  }
});

/** localStorage, as much of it as the cache uses. */
function memoryStore(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
  };
}

function session(first: SessionState) {
  let state = first;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    become(next: SessionState) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

const maya = { id: "usr_1", githubLogin: "maya", name: "Maya", email: null, avatarUrl: null };

test("signing out takes the designs kept for offline with it, and nothing is kept after", async () => {
  const store = memoryStore();
  store.setItem("ponzu.ui.usr_1", "{}");
  const account = session({ status: "signed_in", user: maya });
  const cache = signedInCache(account, store);
  await cache.set("dsn_1", "the whole design, and its asset key");
  expect(await cache.get("dsn_1")).toBe("the whole design, and its asset key");

  account.become({ status: "signed_out" });
  expect(store.getItem("ponzu.cache.dsn_1")).toBeNull();
  // A design closing as the window unmounts saves a copy: not any more.
  await cache.set("dsn_1", "late");
  expect(store.getItem("ponzu.cache.dsn_1")).toBeNull();
  expect(await cache.get("dsn_1")).toBeNull();
  // The cache keeps to its own keys.
  expect(store.getItem("ponzu.ui.usr_1")).toBe("{}");
});

test("opened signed out, the designs kept from before go at once and the window state stays", () => {
  // Ponzu Dev's first launch: Ponzu Preview's storage came over whole, and nobody is signed in.
  const store = memoryStore();
  store.setItem("ponzu.ui.usr_1", '{"sidebar":"open"}');
  store.setItem("ponzu.cache.dsn_1", "the whole design, and its asset key");
  signedInCache(session({ status: "signed_out" }), store);
  expect(store.getItem("ponzu.cache.dsn_1")).toBeNull();
  expect(store.getItem("ponzu.ui.usr_1")).toBe('{"sidebar":"open"}');

  // Still finding out: nothing goes until the answer is in.
  const later = memoryStore();
  later.setItem("ponzu.cache.dsn_1", "kept");
  const account = session({ status: "loading" });
  signedInCache(account, later);
  expect(later.getItem("ponzu.cache.dsn_1")).toBe("kept");
  account.become({ status: "signed_out" });
  expect(later.getItem("ponzu.cache.dsn_1")).toBeNull();
});
