import type { QueryClient } from "@tanstack/react-query";
import type { Live } from "../live/live.ts";
import type { MeRow } from "../live/rows.ts";
import { queryKeys } from "./keys.ts";

/** What of the person's row each cached answer is about, to tell a change from a redelivery. */
function parts(row: MeRow | undefined) {
  if (!row) return { me: "", claude: "", defaults: "" };
  const { claudeAccount, defaultAgent, defaultModel, defaultEffort } = row;
  return {
    me: JSON.stringify(row),
    claude: JSON.stringify(claudeAccount),
    defaults: JSON.stringify([defaultAgent, defaultModel, defaultEffort]),
  };
}

/**
 * Where a live query and a cached answer cover the same rows, the live query says when the
 * answer is out of date. The person's own row (`me`: where setup stands, their Claude, their
 * defaults) changing on another device, or by a job on the API, asks again for `GET /v1/me`,
 * and for the answers about their Claude and their defaults when those columns changed. The
 * first rows are the state the answers were read in, so only a change after them counts; the
 * same rows delivered again (a resubscribe, a resume) are no change. Answers the unsubscribe.
 */
export function invalidateFromLive(queryClient: QueryClient, live: Live): () => void {
  let known: ReturnType<typeof parts> | undefined;
  return live.subscribe("me", {}, ({ rows }) => {
    if (rows === undefined) return;
    const now = parts(rows[0]);
    if (known !== undefined && now.me !== known.me) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me() });
      if (now.claude !== known.claude) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.claudeAccount() });
      }
      if (now.defaults !== known.defaults) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.claudeDefaults() });
      }
    }
    known = now;
  });
}
