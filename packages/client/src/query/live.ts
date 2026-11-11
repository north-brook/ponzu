import type { QueryClient } from "@tanstack/react-query";
import type { Live } from "../live/live.ts";
import { queryKeys } from "./keys.ts";

/**
 * Where a live query and a cached answer cover the same rows, the live query says when the
 * answer is out of date. The person's own row (`me`: where setup stands, their Claude, their
 * defaults) changing on another device, or by a job on the API, asks again for `GET /v1/me`
 * and the answers about their Claude. The first rows are the state the answers were read in,
 * so only a change after them counts. Answers the unsubscribe.
 */
export function invalidateFromLive(queryClient: QueryClient, live: Live): () => void {
  let known: readonly unknown[] | undefined;
  return live.subscribe("me", {}, ({ rows }) => {
    if (rows === undefined) return;
    if (known !== undefined && rows !== known) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.claudeAccount() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.claudeDefaults() });
    }
    known = rows;
  });
}
