import type { AppType } from "@ponzu/api/types";
import { hc, type InferResponseType } from "hono/client";

/** The API's routes as a typed client: `rpc.v1.canvases[":id"].$get(…)`. */
export type Rpc = ReturnType<typeof hc<AppType>>;

/** `fetch` as this package takes it: without the extras a runtime's own may carry. */
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createRpc(apiUrl: string, fetch: Fetch): Rpc {
  return hc<AppType>(apiUrl, { fetch: fetch as typeof globalThis.fetch });
}

/** A person as the API names them: what the sign-in exchange and `/v1/me` both answer with. */
export type Profile = InferResponseType<Rpc["v1"]["auth"]["exchange"]["$post"], 200>["user"];
