import {
  findStops,
  noteRunnerSaid,
  type ThreadWrite as StoredWrite,
  writeThreadItems,
} from "@ponzu/db";
import type { Notice, ThreadResponse, ThreadWrite } from "@ponzu/runner/protocol";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";

/**
 * A runner's thread write (docs/cloud.md, "The runner protocol", "The thread"). The runner
 * names a stop by its event; the thread says who stopped the run, which the API takes from
 * that event and never from the sandbox. A `stopped` notice that names no stop of this design
 * refuses the whole write, as a notice type a runner may not write does (in the schema).
 *
 * A write that says anything of a turn is the turn answering what was delivered before it, so
 * it moves `design_runners.said_at` on ("A turn that never came").
 */
export async function writeRunnerThread(
  deps: Pick<Deps, "db" | "clock">,
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
  const written = await writeThreadItems(deps.db, { designId, items: stored });
  if (items.some(saysOfATurn)) {
    await noteRunnerSaid(deps.db, { designId, now: new Date(deps.clock.now()) });
  }
  return { items: written };
}

/**
 * Whether an item is the agent answering: its words, a turn's work, a question, a stop, or a
 * turn's error. Not the notices of a runner starting (`waking`, `resumed`, `started`), and not
 * the errors that are no turn's (a checkout that failed as it started, a push after the turn).
 */
export function saysOfATurn(item: ThreadWrite): boolean {
  if (item.kind !== "notice") return true;
  const notice = item.payload;
  if (notice.type === "question" || notice.type === "stopped") return true;
  return notice.type === "error" && notice.code !== "clone_failed" && notice.code !== "push_failed";
}
