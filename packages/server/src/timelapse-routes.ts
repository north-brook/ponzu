import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  FILM_LENGTHS,
  FILM_SHAPES,
  type FilmLength,
  type FilmShape,
  JOURNAL_FILE,
} from "@ponzu/core";
import { filmSidecar, type TimelapseJob, timelapseInfo } from "./timelapse.ts";
import type { LocalWorkspace } from "./workspace.ts";

/**
 * The studio's timelapse API, for this Mac only:
 *   GET  /api/timelapse/journal?file=      the journal, for the film page
 *   GET  /api/timelapse/info?file=         range, last session and comment times
 *   POST /api/timelapse?file=              start a film { range?, theme }
 *   GET  /api/timelapse/status?file=       the latest film's state
 *   GET  /api/timelapse/poster?id=         its latest frame, JPEG
 *   GET  /api/timelapse/video?id=          the finished film
 *   GET  /api/timelapse/films?file=        the films in its exports/ folder, newest first
 *   GET  /api/timelapse/film?file=&name=   one of them
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
    // No length: the timelapse, as long as what was made takes at its pace.
    const length = FILM_LENGTHS.includes(body.length as FilmLength)
      ? (body.length as number)
      : undefined;
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
  if (path === "/api/timelapse/films") {
    if (!key) return new Response("Not open", { status: 404 });
    return Response.json(await films(key));
  }
  if (path === "/api/timelapse/film") {
    const name = url.searchParams.get("name") ?? "";
    // Only a film by its own name in exports/: never a path out of it.
    if (!key || !FILM_NAME.test(name) || basename(name) !== name)
      return new Response("Not found", { status: 404 });
    const at = join(key, "exports", name);
    if (!(await stat(at).catch(() => null))) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(at), {
      headers: {
        "content-type": name.endsWith(".webm") ? "video/webm" : "video/mp4",
        "content-disposition": `inline; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
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

/** A timelapse's file name in exports/, as timelapsePath names them. */
const FILM_NAME = /^timelapse-\d{4}-\d{2}-\d{2}(-\d+)?\.(mp4|webm)$/;

/** The timelapses made of a design, from its exports/ folder, newest first. */
export async function films(key: string) {
  const dir = join(key, "exports");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => FILM_NAME.test(n));
  const out = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const s = await stat(path).catch(() => null);
      if (!s) return null;
      // What it covered, when it was made with a sidecar (older films play without one).
      const side =
        (await readFile(filmSidecar(path), "utf8")
          .then((t) => JSON.parse(t) as { range?: { from: number; to: number }; duration?: number })
          .catch(() => null)) ?? {};
      return {
        name,
        path,
        bytes: s.size,
        at: s.mtimeMs,
        ...(side.range ? { range: side.range } : {}),
        ...(side.duration ? { duration: side.duration } : {}),
      };
    }),
  );
  return out.filter((f) => f !== null).sort((a, b) => b.at - a.at);
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
