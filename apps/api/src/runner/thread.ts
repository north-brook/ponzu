import { findStops, type ThreadWrite as StoredWrite, writeThreadItems } from "@ponzu/db";
import type { Notice, ThreadResponse, ThreadWrite } from "@ponzu/runner/protocol";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";

/**
 * A runner's thread write (docs/cloud.md, "The runner protocol", "The thread"). The runner
 * names a stop by its event; the thread says who stopped the run, which the API takes from
 * that event and never from the sandbox. A `stopped` notice that names no stop of this design
 * refuses the whole write, as a notice type a runner may not write does (in the schema).
 */
export async function writeRunnerThread(
  deps: Pick<Deps, "db">,
  designId: string,
  items: ThreadWrite[],
): Promise<ThreadResponse> {
  const stopIds = items.flatMap((item) =>
    item.kind === "notice" && item.payload.type === "stopped" ? [item.payload.eventId] : [],
  );
  const stops = new Map(
    (await findStops(deps.db, { designId, ids: stopIds })).map((stop) => [stop.id, stop.from]),
  );
  const stored = items.map((item): StoredWrite => {
    if (item.kind !== "notice" || item.payload.type !== "stopped") {
      return { ...item, payload: { ...item.payload } };
    }
    const by = stops.get(item.payload.eventId);
    if (by === undefined) {
      throw new ApiError(400, "invalid_request", "That is not one of this design's stops.");
    }
    const payload: Notice = { type: "stopped", by };
    return { ...item, payload: { ...payload } };
  });
  return { items: await writeThreadItems(deps.db, { designId, items: stored }) };
}
