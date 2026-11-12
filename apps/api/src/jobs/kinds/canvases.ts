import { CANVAS_FILES_DELETE_JOB, runCanvasFilesDeleteJob } from "../../canvases/files.ts";
import { runWakeJob, WAKE_JOB } from "../../sandboxes/orchestrate.ts";
import type { JobKinds } from "../registry.ts";

/** A canvas: waking its sandbox, and deleting its files once it is purged. */
export const canvasJobs = (): JobKinds => ({
  [WAKE_JOB]: runWakeJob,
  [CANVAS_FILES_DELETE_JOB]: runCanvasFilesDeleteJob,
});
