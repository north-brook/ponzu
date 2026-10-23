/**
 * Time limits for each step of a render, and the error that names the step
 * that ran out. Shared by every renderer. It has no imports, so the desktop
 * app's render host can bundle it too.
 *
 * Without them a render that stalled (a font that never arrived, a host
 * blocked behind a dialog) waited for the runtime's own fetch timeout, six
 * minutes, and then said only "The operation timed out."
 */

/** Where a render was when it failed. */
export type RenderStage = "queue" | "load" | "assets" | "prepare" | "lint" | "capture";

/** Why, coarsely. These are the only values telemetry may send. */
export type RenderFailure =
  | "host_unreachable"
  | "host_unresponsive"
  | "host_busy"
  | "timeout"
  | "capture_failed"
  | "render_error";

export const RENDER_FAILURES: readonly RenderFailure[] = [
  "host_unreachable",
  "host_unresponsive",
  "host_busy",
  "timeout",
  "capture_failed",
  "render_error",
];

export const RENDER_STAGES: readonly RenderStage[] = [
  "queue",
  "load",
  "assets",
  "prepare",
  "lint",
  "capture",
];

/**
 * Milliseconds each step may take. Renders usually finish in a quarter of a
 * second, so these only stop ones that are stuck. Fonts and images ("assets")
 * don't fail the render when they run out: it goes on with what has loaded.
 */
export const STAGE_BUDGET_MS: Record<RenderStage, number> = {
  queue: 20_000,
  load: 15_000,
  assets: 8_000,
  prepare: 15_000,
  lint: 10_000,
  capture: 20_000,
};

/** How long a client waits for a render host to answer one request. */
export const HOST_DEADLINE_MS = 60_000;

/**
 * One step of a film page: building a reel (laying out and measuring every board) or finishing
 * its encode takes longer than a render's settling, and grows with the design.
 */
export const FILM_STEP_MS = 180_000;

const DOING: Record<RenderStage, string> = {
  queue: "waiting for other renders to finish",
  load: "loading the page",
  assets: "loading fonts and images",
  prepare: "settling animations and states",
  lint: "running lint",
  capture: "capturing the image",
};

export class RenderError extends Error {
  constructor(
    message: string,
    readonly failure: RenderFailure,
    readonly stage?: RenderStage,
    /** The render host's HTTP status, when it answered with an error. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "RenderError";
  }
}

/** A step that ran past its budget, in words. */
export function stalled(stage: RenderStage, ms = STAGE_BUDGET_MS[stage]): string {
  return `The render stalled ${DOING[stage]} (stopped after ${Math.round(ms / 1000)}s).`;
}

/** `work`, or a RenderError naming `stage` when it runs past `ms`. */
export function withBudget<T>(
  stage: RenderStage,
  work: Promise<T>,
  ms = STAGE_BUDGET_MS[stage],
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RenderError(stalled(stage, ms), stage === "queue" ? "host_busy" : "timeout", stage),
        ),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Whether `work` settled, either way, within `ms`. It's left to finish on its own if not. */
export function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
