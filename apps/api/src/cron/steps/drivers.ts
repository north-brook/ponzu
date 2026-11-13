import { listLapsedDrivers } from "@ponzu/db";
import { endDrive } from "../../canvases/drive.ts";
import type { CronStep } from "../steps.ts";

/**
 * Ending the drives whose agent has gone quiet (docs/cloud.md, "Driving a canvas"): a lease
 * unseen for 30 minutes is over already for every read, and this takes it off the canvas, says
 * so in its thread, and gives the canvas back to Ponzu's agent for what people sent meanwhile.
 */
export const driversStep: CronStep = {
  name: "drivers",
  run: async (deps) => {
    let ended = 0;
    for (const canvasId of await listLapsedDrivers(deps.db)) {
      if (await endDrive(deps, { canvasId, how: "lapsed" })) ended++;
    }
    return { ended };
  },
};
