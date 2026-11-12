/*
 * The runner's fake API, served inside a test sandbox so the runner can be driven there before
 * the real API is deployed: `bun fake-api.js`, started by the driver (live.ts) as the sandbox's
 * own user at every start of the sandbox, before ponzu-start, with the runner's own
 * PONZU_DESIGN_ID, PONZU_RUNNER_TOKEN and PONZU_PORT_TOKEN in its command's env. The runner
 * reaches it on localhost as it would reach the API.
 *
 * It serves `GET /v1/runner/bundle` as the API does: the runner bundle's tgz (from
 * PONZU_FAKE_API_BUNDLE), behind the runner token, with `x-ponzu-bundle-sha256`. ponzu-start
 * fetches it when the disk does not have the bundle the start names.
 *
 * Under `/control/` (the same bearer) the driver on the other side of the sandbox's address
 * pushes events and reads back what the runner did. What a new session must not lose (the
 * session's Claude session id, the document, the last checkpoint and its archives) is kept in a
 * file; a git token is never written.
 *
 * The real API is not on the sandbox's disk, so a sandbox that is removed and made again (or
 * comes back older) leaves it as it was. To act that out, the driver keeps the fake's memory on
 * its own machine (`GET /control/memory`) and, with PONZU_FAKE_API_HOLD=1, the fake answers the
 * runner 503 until the driver hands it back (`PUT /control/memory`): the runner retries, as it
 * does against an API it cannot reach.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { emptyDoc } from "@ponzu/core";
import { FakeRunnerApi } from "../../src/api/fake.ts";
import { fakeApiHandler } from "../../src/api/fake-http.ts";
import type {
  EventBody,
  Priority,
  RunnerSession,
  SavedPoint,
  StateRequest,
} from "../../src/api/protocol.ts";
import { writeDurably } from "../../src/durable.ts";

const designId = need("PONZU_DESIGN_ID");
const token = need("PONZU_RUNNER_TOKEN");
const port = Number(process.env.PONZU_FAKE_API_PORT ?? 8790);
const runnerPort = Number(process.env.PONZU_RUNNER_PORT ?? 4600);
/** The runner's port answers only the bearer of its port token, on localhost too. */
const runnerDoor = { authorization: `Bearer ${process.env.PONZU_PORT_TOKEN ?? ""}` };
const stateFile = process.env.PONZU_FAKE_API_STATE ?? `${process.env.HOME}/.ponzu-fake-api.json`;
/** Held until the driver hands back the memory it kept: what the real API would remember. */
let held = process.env.PONZU_FAKE_API_HOLD === "1";

/** What the fake keeps, on its disk and on the driver's machine. */
interface Kept {
  session: FakeRunnerApi["sessionInfo"];
  doc: ReturnType<FakeRunnerApi["doc"]["snapshot"]>["doc"];
  /** The feed goes on from here: the transcript already holds the events before it. */
  feedSeq: number;
  saved: SavedPoint | null;
  /** The checkpoint's archives, in base64. */
  archives: { session: string | null; workspace: string | null };
  /** How many times the state was written: the driver checks a fresh start read the last. */
  writes: number;
}
const kept: Kept | null = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : null;
const fake = new FakeRunnerApi({
  doc: kept?.doc ?? emptyDoc("Untitled"),
  session: kept?.session ?? { design: { id: designId, name: "Untitled" }, model: "haiku" },
  feedSeq: kept?.feedSeq ?? 0,
});
const unbase = (s: string | null | undefined) =>
  s ? new Uint8Array(Buffer.from(s, "base64")) : null;
const base = (b: Uint8Array | null) => (b ? Buffer.from(b).toString("base64") : null);
function take(state: Partial<Kept>): void {
  fake.saved = state.saved ?? null;
  fake.archives = {
    session: unbase(state.archives?.session),
    workspace: unbase(state.archives?.workspace),
  };
}
take(kept ?? {});
let writes = kept?.writes ?? 0;
/** What the state file said when this process started. */
const restored = { writes, feedSeq: fake.feedSeq, savedTurn: fake.saved?.turn ?? null };
const started = Date.now();
/** State reports and every call, with when they arrived. */
const states: (StateRequest & { at: number })[] = [];
const calls: { at: number; route: string }[] = [];

const api = fakeApiHandler(fake, { designId, token });
Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    // The bundle is served even while held: it is what the start fetches before any runner runs.
    if (route === "GET /v1/runner/bundle") return serveBundle(request);
    if (!url.pathname.startsWith("/control/")) {
      if (held)
        return Response.json(
          { error: { code: "upstream_unavailable", message: "held for the driver" } },
          { status: 503 },
        );
      calls.push({ at: Date.now(), route });
      if (route === "PUT /v1/runner/state" && authorized(request))
        states.push({ ...((await request.clone().json()) as StateRequest), at: Date.now() });
      return api(request);
    }
    if (!authorized(request)) return new Response(null, { status: 401 });
    return control(route, url, request);
  },
});

function memory(): Kept {
  return {
    session: fake.sessionInfo,
    doc: fake.doc.snapshot().doc,
    feedSeq: fake.feedSeq,
    saved: fake.saved,
    archives: { session: base(fake.archives.session), workspace: base(fake.archives.workspace) },
    writes,
  };
}

async function control(route: string, url: URL, request: Request): Promise<Response> {
  switch (route) {
    case "GET /control/record":
      return Response.json({
        now: Date.now(),
        started,
        held,
        items: fake.items(),
        states,
        usage: [...fake.usage.values()],
        uploads: fake.uploads.map(({ bytes, ...file }, index) => ({
          index,
          ...file,
          size: bytes.length,
        })),
        delivered: fake.delivered,
        events: fake.events.map((e) => e.event.id),
        session: fake.sessionInfo,
        doc: fake.doc.snapshot(),
        saved: fake.saved,
        checkpoints: fake.checkpoints,
        restored: fake.restored,
        summaries: fake.summaries,
        bundles,
        calls: calls.length,
        lastCall: calls.at(-1) ?? null,
        claims: calls
          .filter((c) => c.route === "POST /v1/runner/events/claim")
          .slice(-20)
          .map((c) => c.at),
        kept: { writes, restored },
      });
    case "GET /control/memory":
      return Response.json(memory());
    case "PUT /control/memory": {
      const body = (await request.json()) as Kept;
      Object.assign(fake.sessionInfo, body.session);
      take(body);
      held = false;
      keep(true);
      return new Response(null, { status: 204 });
    }
    case "POST /control/release":
      held = false;
      return new Response(null, { status: 204 });
    case "POST /control/poke":
      // As the API's wake of an awake row: the runner is only poked.
      await fetch(`http://127.0.0.1:${runnerPort}/poke`, {
        method: "POST",
        headers: runnerDoor,
      }).catch(() => {});
      return new Response(null, { status: 204 });
    case "POST /control/events": {
      const body = (await request.json()) as EventBody & { priority?: Priority };
      const event = fake.push(body, body.priority ? { priority: body.priority } : {});
      keep();
      await fetch(`http://127.0.0.1:${runnerPort}/poke`, {
        method: "POST",
        headers: runnerDoor,
      }).catch(() => {});
      return Response.json(event);
    }
    case "PUT /control/session":
      Object.assign(fake.sessionInfo, (await request.json()) as Partial<RunnerSession>);
      keep();
      return Response.json(fake.sessionInfo);
    case "PUT /control/git-token":
      fake.gitToken = (await request.json()) as FakeRunnerApi["gitToken"];
      return new Response(null, { status: 204 });
  }
  const upload = /^GET \/control\/uploads\/(\d+)$/.exec(route);
  const file = upload ? fake.uploads[Number(upload[1])] : undefined;
  if (file)
    return new Response(Buffer.from(file.bytes), { headers: { "content-type": file.contentType } });
  return new Response(`nothing at ${url.pathname}`, { status: 404 });
}

/** Written as the runner writes what it keeps: whole, and on the disk before it is answered. */
let last = "";
function keep(force = false): void {
  const { writes: _, ...state } = memory();
  const json = JSON.stringify(state);
  if (json === last && !force) return;
  last = json;
  writes += 1;
  writeDurably(stateFile, JSON.stringify({ ...state, writes } satisfies Kept));
}
setInterval(keep, 500);

/** How many times the bundle was served: a start on a disk that has it fetches nothing. */
let bundles = 0;

/** `GET /v1/runner/bundle`, as the API answers it. */
function serveBundle(request: Request): Response {
  if (!authorized(request)) return new Response(null, { status: 401 });
  const file = process.env.PONZU_FAKE_API_BUNDLE;
  if (!file || !existsSync(file)) return new Response("no bundle", { status: 404 });
  const bytes = readFileSync(file);
  bundles += 1;
  return new Response(bytes, {
    headers: {
      "content-type": "application/gzip",
      "x-ponzu-bundle-sha256": createHash("sha256").update(bytes).digest("hex"),
    },
  });
}

function authorized(request: Request): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

console.log(`fake API for ${designId} on ${port}${held ? " (held)" : ""}`);
