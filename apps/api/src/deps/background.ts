import type { Logger } from "../http/log.ts";

/**
 * Work a request starts and answers without waiting for: `deps.background("wake", wake(…))`.
 * `name` says what it was in the log if it fails.
 *
 * This is the only way to leave a promise running past a response. A promise nobody holds is
 * frozen with the instance once the response is sent, and if it rejects, Node ends the
 * process and every other request it was serving. Work that must finish whatever happens to
 * the instance is also a row in `jobs`; this only starts it sooner.
 */
export type Background = (name: string, work: Promise<unknown>) => void;

/**
 * `keep` is handed each piece of work so that something waits for it: Vercel's `waitUntil` in
 * a deployment, a list a test can wait on under `createTestApp`. What it is handed never
 * rejects: a failure is logged as `background_failed` and ends there.
 */
export function createBackground(log: Logger, keep: (work: Promise<void>) => void): Background {
  return (name, work) =>
    keep(
      work.then(
        () => {},
        (error) => {
          log.error("background_failed", { name, error });
        },
      ),
    );
}

/**
 * Vercel's `waitUntil`: keeps the function instance alive until `work` settles. This is the
 * whole of what `@vercel/functions` does for it, and that package brings half a megabyte of
 * other things into the bundle with it. Vercel puts the current request's context behind
 * this symbol; anywhere else (`bun run dev`) there is none, and the work simply runs.
 */
export function waitUntil(work: Promise<void>): void {
  const store = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
    | { get?: () => { waitUntil?: (work: Promise<void>) => void } | undefined }
    | undefined;
  store?.get?.()?.waitUntil?.(work);
}
