import { getCanvas } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";

/**
 * Captures something about a canvas under its workspace, for a caller that has only the
 * canvas's id (a runner's request, which knows its canvas and nothing else). The canvas is read
 * in the background, so the request neither waits for the read nor fails with it.
 */
export function captureForCanvas(
  deps: Pick<Deps, "db" | "analytics" | "background">,
  canvasId: string,
  capture: (workspaceId: string) => void,
): void {
  deps.background(
    "analytics",
    getCanvas(deps.db, canvasId).then((canvas) => {
      if (canvas) capture(canvas.workspaceId);
    }),
  );
}
