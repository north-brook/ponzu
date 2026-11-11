/*
 * Where this build talks to. A packaged build always talks to Ponzu Cloud; a development build
 * (`bun run start`) can be pointed elsewhere, and can load the studio from Vite's dev server.
 */

export interface Config {
  apiUrl: string;
  /** The WorkOS environment's client id: public, the app ships it. Staging until cutover. */
  workosClientId: string;
  /** Vite's dev server, when a development build loads the studio from it. */
  studioDevUrl: string | null;
  /** `ponzu`, or `ponzu-dev` for a development build, so it never takes an installed app's links. */
  linkScheme: string;
}

const API_URL = "https://api.ponzu.design";
const WORKOS_CLIENT_ID = "client_01M72Y00K1VV63G6V5D25YCE6K";

export function configFor(packaged: boolean, env: NodeJS.ProcessEnv): Config {
  if (packaged) {
    return {
      apiUrl: API_URL,
      workosClientId: WORKOS_CLIENT_ID,
      studioDevUrl: null,
      linkScheme: "ponzu",
    };
  }
  return {
    apiUrl: localOrHttps(env.PONZU_API_URL) ?? API_URL,
    workosClientId: env.PONZU_WORKOS_CLIENT_ID || WORKOS_CLIENT_ID,
    studioDevUrl: localOrHttps(env.PONZU_STUDIO_URL),
    linkScheme: "ponzu-dev",
  };
}

/** An https URL, or http on this computer; anything else is ignored. Without a trailing slash. */
function localOrHttps(value: string | undefined): string | null {
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.origin;
}
