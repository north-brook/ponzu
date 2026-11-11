import { ApiError, borrowSession, createApi, createLive } from "@ponzu/client";
import type { PonzuDesktop } from "@ponzu/desktop/bridge";
import { type Host, localStorageKv } from "./host.ts";

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
  const api = createApi(session);
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
    docStorage: localStorageKv("ponzu.cache."),
  };
}
