import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  FILM_LENGTHS,
  FILM_SHAPES,
  type FilmLength,
  type FilmShape,
  JOURNAL_FILE,
} from "@ponzu/core";
import { type TimelapseJob, timelapseInfo } from "./timelapse.ts";
import type { LocalWorkspace } from "./workspace.ts";

/**
 * The studio's timelapse API, for this Mac only:
 *   GET  /api/timelapse/journal?file=      the journal, for the film page
 *   GET  /api/timelapse/info?file=         range, last session and comment times
 *   POST /api/timelapse?file=              start a film { shape, length, range?, theme }
 *   GET  /api/timelapse/status?file=       the latest film's state
 *   GET  /api/timelapse/poster?id=         its latest frame, JPEG
 *   GET  /api/timelapse/video?id=          the finished film
 *   POST /api/timelapse/cancel?id=
 */
export async function timelapseRoute(
  ws: LocalWorkspace,
  req: Request,
  url: URL,
  path: string,
): Promise<Response | null> {
  const file = url.searchParams.get("file");
  const key = file ? ws.get(file) && file : null;
  const id = url.searchParams.get("id");

  if (path === "/api/timelapse/journal") {
    if (!key) return new Response("Not open", { status: 404 });
    await ws.journalFlushed(key);
    const text = await readFile(join(key, JOURNAL_FILE), "utf8").catch(() => "");
    return new Response(text, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
    });
  }
  if (path === "/api/timelapse/info") {
    if (!key) return new Response("Not open", { status: 404 });
    await ws.journalFlushed(key);
    const job = ws.timelapses.latest(key);
    return Response.json({
      ...(await timelapseInfo(key)),
      renderer: Boolean(ws.renderer?.filmDriver),
      job: job ? jobJson(job) : null,
    });
  }
  if (path === "/api/timelapse" && req.method === "POST") {
    if (!key) return new Response("Not open", { status: 404 });
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const shape = FILM_SHAPES.includes(body.shape as FilmShape)
      ? (body.shape as FilmShape)
      : "16:9";
    const length = FILM_LENGTHS.includes(body.length as FilmLength) ? (body.length as number) : 30;
    const theme = body.theme === "dark" ? "dark" : "light";
    const r = body.range as { from?: unknown; to?: unknown } | undefined;
    const range =
      r && typeof r.from === "number" && typeof r.to === "number"
        ? { from: r.from, to: r.to }
        : undefined;
    try {
      const job = ws.timelapses.start(key, { shape, length, theme, range });
      return Response.json(jobJson(job));
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 409 },
      );
    }
  }
  if (path === "/api/timelapse/status") {
    if (!key) return new Response("Not open", { status: 404 });
    const job = ws.timelapses.latest(key);
    return Response.json(job ? jobJson(job) : null);
  }
  const job = id ? ws.timelapses.get(id) : undefined;
  if (path === "/api/timelapse/poster") {
    if (!job?.poster) return new Response("Not yet", { status: 404 });
    return new Response(job.poster as BodyInit, {
      headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
    });
  }
  if (path === "/api/timelapse/video") {
    if (!job || job.state.status !== "done") return new Response("Not found", { status: 404 });
    const s = await stat(job.state.path).catch(() => null);
    if (!s) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(job.state.path), {
      headers: {
        "content-type": job.state.mime,
        "content-disposition": `inline; filename="${job.state.path.split("/").pop()}"`,
        "cache-control": "no-store",
      },
    });
  }
  if (path === "/api/timelapse/cancel" && req.method === "POST") {
    return Response.json({ cancelled: Boolean(id && ws.timelapses.cancel(id)) });
  }
  return null;
}

export function jobJson(job: TimelapseJob) {
  return {
    id: job.id,
    file: job.key,
    request: job.request,
    state: job.state,
    poster: Boolean(job.poster),
  };
}
