import { getDesign } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";

/**
 * Captures something about a design under its workspace, for a caller that has only the
 * design's id (a runner's request, which knows its design and nothing else). The design is read
 * in the background, so the request neither waits for the read nor fails with it.
 */
export function captureForDesign(
  deps: Pick<Deps, "db" | "analytics" | "background">,
  designId: string,
  capture: (workspaceId: string) => void,
): void {
  deps.background(
    "analytics",
    getDesign(deps.db, designId).then((design) => {
      if (design) capture(design.workspaceId);
    }),
  );
}
