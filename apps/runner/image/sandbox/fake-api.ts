/*
 * The runner's fake API, served inside a test sandbox so the runner can be driven there before
 * the real API is deployed: `bun fake-api.js`, as a systemd unit beside the runner's, with the
 * runner's own PONZU_DESIGN_ID and PONZU_RUNNER_TOKEN from boat's environment file. The runner
 * reaches it on localhost as it would reach the API.
 *
 * Under `/control/` (the same bearer) the driver on the other side of the sandbox's address
 * pushes events and reads back what the runner did. What a cold start must not lose (the
 * session's Claude session id, the document) is kept in a file; a git token is never written.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { emptyDoc } from "@ponzu/core";
import { FakeRunnerApi } from "../../src/api/fake.ts";
import { fakeApiHandler } from "../../src/api/fake-http.ts";
import type { EventBody, Priority, RunnerSession, StateRequest } from "../../src/api/protocol.ts";

const designId = need("PONZU_DESIGN_ID");
const token = need("PONZU_RUNNER_TOKEN");
const port = Number(process.env.PONZU_FAKE_API_PORT ?? 8790);
const runnerPort = Number(process.env.PONZU_RUNNER_PORT ?? 4600);
const stateFile = process.env.PONZU_FAKE_API_STATE ?? `${process.env.HOME}/.ponzu-fake-api.json`;

interface Kept {
  session: FakeRunnerApi["sessionInfo"];
  doc: ReturnType<FakeRunnerApi["doc"]["snapshot"]>["doc"];
  /** The feed goes on from here: the transcript already holds the events before it. */
  feedSeq: number;
}
const kept: Kept | null = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : null;
const fake = new FakeRunnerApi({
  doc: kept?.doc ?? emptyDoc("Untitled"),
  session: kept?.session ?? { design: { id: designId, name: "Untitled" }, model: "haiku" },
  // The clock too, so that no restart repeats an id even if the file it reads is an old one.
  feedSeq: Math.max(kept?.feedSeq ?? 0, Math.floor(Date.now() / 1000)),
});
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
    if (!url.pathname.startsWith("/control/")) {
      calls.push({ at: Date.now(), route });
      if (route === "PUT /v1/runner/state" && authorized(request))
        states.push({ ...((await request.clone().json()) as StateRequest), at: Date.now() });
      return api(request);
    }
    if (!authorized(request)) return new Response(null, { status: 401 });
    return control(route, url, request);
  },
});

async function control(route: string, url: URL, request: Request): Promise<Response> {
  switch (route) {
    case "GET /control/record":
      return Response.json({
        now: Date.now(),
        started,
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
        calls: calls.length,
        lastCall: calls.at(-1) ?? null,
      });
    case "POST /control/events": {
      const body = (await request.json()) as EventBody & { priority?: Priority };
      const event = fake.push(body, body.priority ? { priority: body.priority } : {});
      keep();
      await fetch(`http://127.0.0.1:${runnerPort}/poke`, { method: "POST" }).catch(() => {});
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

/** Written whole and then moved, so a cold start never reads half a file. */
let last = "";
function keep(): void {
  const state: Kept = {
    session: fake.sessionInfo,
    doc: fake.doc.snapshot().doc,
    feedSeq: fake.feedSeq,
  };
  const json = JSON.stringify(state);
  if (json === last) return;
  last = json;
  writeFileSync(`${stateFile}.new`, json);
  renameSync(`${stateFile}.new`, stateFile);
}
setInterval(keep, 500);

function authorized(request: Request): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

console.log(`fake API for ${designId} on ${port}`);
