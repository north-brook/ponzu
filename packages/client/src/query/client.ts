import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../errors.ts";

/** How many times a query that failed for a reason that may pass is asked again. */
const RETRIES = 2;

/**
 * The QueryClient the apps share the settings of: one per signed-in person, made at sign-in
 * and dropped at sign-out, so nothing of one person's answers reaches the next.
 *
 * A query is asked again only for a failure that may pass (no answer, a 5xx, a 429): a 403 or a
 * 404 is the answer. Mutations are never repeated by the client, since not every one is safe
 * to send twice; those that are say so (`createKey`). An answer is taken as fresh for half a
 * minute, and asked again when the window comes back to the front after that.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failures, error) =>
          failures < RETRIES && !(error instanceof ApiError && !error.transient),
      },
      mutations: { retry: false },
    },
  });
}
