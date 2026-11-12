import { ASSET_KEY_RETIRE_JOB, runAssetKeyRetireJob } from "../../canvases/asset-key.ts";
import { CANVAS_FILES_DELETE_JOB, runCanvasFilesDeleteJob } from "../../canvases/files.ts";
import { runWakeJob, WAKE_JOB } from "../../sandboxes/orchestrate.ts";
import type { JobKinds } from "../registry.ts";

/**
 * A canvas: waking its sandbox, deleting its files once it is purged, and retiring an asset key
 * its file links were reset from.
 */
export const canvasJobs = (): JobKinds => ({
  [WAKE_JOB]: runWakeJob,
  [CANVAS_FILES_DELETE_JOB]: runCanvasFilesDeleteJob,
  [ASSET_KEY_RETIRE_JOB]: runAssetKeyRetireJob,
});
