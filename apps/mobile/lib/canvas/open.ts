import { router } from "expo-router";
import { tick } from "../haptics";

/** The in-app path of a canvas: the route a row, a link or a push opens (app/canvas/[id].tsx). */
export function canvasPath(canvasId: string): `/canvas/${string}` {
  return `/canvas/${encodeURIComponent(canvasId)}`;
}

/** Open a canvas from a row: the tick, then the canvas pushed over the list. */
export function openCanvas(canvasId: string): void {
  tick();
  router.push(canvasPath(canvasId));
}
