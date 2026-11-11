import {
  ApiError,
  borrowSession,
  createApi,
  createLive,
  type KeyValueStorage,
  type LinkScheme,
  type Session,
} from "@ponzu/client";
import type { PonzuDesktop } from "@ponzu/desktop/bridge";
import type { Host } from "./host.ts";

/**
 * The studio inside the Mac app. The main process holds the session; this borrows an access
 * token for each request over the bridge and sends the request itself, from the studio's own
 * origin, which the API allows.
 */
export function desktopHost(desktop: PonzuDesktop): Host {
  const session = borrowSession({
    apiUrl: desktop.config.apiUrl,
    client: { platform: desktop.config.client, version: desktop.version },
    lender: {
      getState: () => desktop.session.state(),
      onState: (listener) => desktop.session.onState(listener),
      async accessToken(rejected) {
        const lent = await desktop.session.accessToken(rejected);
        if ("token" in lent) return lent.token;
        const { status, code, message, details } = lent.error;
        throw new ApiError(status, code as ApiError["code"], message, details);
      },
      report: ({ status, code, message, details }) =>
        desktop.session.report({ status, code, message, ...(details ? { details } : {}) }),
      signOut: () => desktop.session.signOut(),
    },
  });
  // GitHub's setup page links back to this app: Ponzu Preview's links aren't Ponzu 1.x's.
  const api = createApi(session, { linkScheme: linkSchemeOf(desktop.config.linkScheme) });
  return {
    session,
    api,
    live: createLive({ api }),
    // The Mac's own lights sit in the chrome; elsewhere the window keeps its own title bar.
    lights: "native",
    signIn: () => desktop.session.signIn(),
    cancelSignIn: () => desktop.session.cancelSignIn(),
    persistence: () => desktop.session.persistence(),
    onLink: (listener) => desktop.onLink(listener),
    onCommand: (listener) => desktop.onCommand(listener),
    update: desktop.update,
    openExternal: (url) => desktop.openExternal(url),
    docStorage: signedInCache(session, window.localStorage),
  };
}

/** The shell's scheme, when it is one the API links back to; otherwise the API's default. */
export function linkSchemeOf(scheme: string | undefined): LinkScheme | undefined {
  return scheme === "ponzu" || scheme === "ponzu-preview" || scheme === "ponzu-dev"
    ? scheme
    : undefined;
}

const CACHE = "ponzu.cache.";

/**
 * The designs last opened, kept to show offline while someone is signed in and only then: they
 * are whole documents of private repos with the keys that open their files. Nothing is written
 * once the session ends (a design closing as its window unmounts would), and what was kept
 * goes with it. The main process clears the studio's storage then too.
 */
export function signedInCache(
  session: Pick<Session, "getState" | "subscribe">,
  store: Storage,
): KeyValueStorage {
  const signedIn = () => session.getState().status === "signed_in";
  const forget = () => {
    const keys = Array.from({ length: store.length }, (_, i) => store.key(i));
    for (const key of keys) if (key?.startsWith(CACHE)) store.removeItem(key);
  };
  session.subscribe(() => {
    if (!signedIn()) forget();
  });
  return {
    get: async (key) => {
      if (!signedIn()) return null;
      try {
        return store.getItem(CACHE + key);
      } catch {
        return null;
      }
    },
    set: async (key, value) => {
      if (signedIn()) store.setItem(CACHE + key, value);
    },
    delete: async (key) => store.removeItem(CACHE + key),
  };
}
