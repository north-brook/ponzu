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
import { linksWithInstalls } from "./installs.ts";

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
  // GitHub's setup page links back to this app: Ponzu Dev's links aren't Ponzu 1.x's. Ponzu
  // Local takes no links and says so: its page links nowhere and says Ponzu has it, which it
  // does, by asking the API (installs.ts).
  const api = createApi(session, { linkScheme: linkSchemeOf(desktop.config.linkScheme) });
  const links = linksWithInstalls({
    api,
    shellLinks: (listener) => desktop.onLink(listener),
    openExternal: (url) => desktop.openExternal(url),
    comeForward: () => desktop.comeForward(),
  });
  return {
    session,
    api,
    live: createLive({ api }),
    // The Mac's own lights sit in the chrome; elsewhere the window keeps its own title bar.
    lights: desktop.platform === "darwin" ? "native" : "none",
    signIn: () => desktop.session.signIn(),
    persistence: () => desktop.session.persistence(),
    onLink: links.onLink,
    installGithub: links.installGithub,
    onCommand: (listener) => desktop.onCommand(listener),
    update: desktop.update,
    openExternal: (url) => desktop.openExternal(url),
    docStorage: signedInCache(session, window.localStorage),
  };
}

/**
 * What the API's pages link back to for the shell's scheme: the scheme, or `none` for a build
 * that takes no links (Ponzu Local's empty one). Never left unsaid, so the page never guesses.
 */
export function linkSchemeOf(scheme: string | undefined): LinkScheme | "none" {
  return scheme === "ponzu" || scheme === "ponzu-dev" ? scheme : "none";
}

const CACHE = "ponzu.cache.";

/**
 * The canvases last opened, kept to show offline while someone is signed in and only then: they
 * are whole documents of private repos with the keys that open their files. Nothing is written
 * once the session ends (a canvas closing as its window unmounts would), and what was kept
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
  // Opened already signed out, with canvases kept from before (Ponzu Dev's first launch, when the
  // main process keeps what came from Ponzu Preview for the window state's sake): drop them now.
  if (!signedIn() && session.getState().status !== "loading") forget();
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
