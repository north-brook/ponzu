import { afterEach, expect, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { RemoteRenderer } from "./remote.ts";
import type { RenderRequest } from "./renderer.ts";

/**
 * RemoteRenderer against stand-in render hosts, so what an agent hears when
 * the desktop app's host is gone, stuck or failing is checked without Electron.
 */

const { artboard } = parseArtboardFile(
  `<section data-artboard data-id="ab_t" data-name="T" style="width:400px;height:300px"><p data-id="n_p">Hi</p></section>`,
  { id: "ab_t", name: "T" },
);
const req = (lint = true): RenderRequest => ({ artboard, tokens: "", lint });

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

/** A host that answers every request with `reply`. */
function host(reply: (req: Request) => Response | Promise<Response>): string {
  // On the address it's dialed at: bound to every address, its port could be
  // one another server holds on 127.0.0.1, which would answer instead.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: reply });
  stop = () => server.stop(true);
  return `http://127.0.0.1:${server.port}/render`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("a host that never answers fails within the deadline and says so", async () => {
  // Before the deadline this waited for Bun's own fetch timeout: six minutes.
  const endpoint = host(() => new Promise<Response>(() => {}));
  const renderer = new RemoteRenderer(endpoint, "t", undefined, { deadlineMs: 300 });
  const started = Date.now();
  const err = await renderer.render(req()).catch((e) => e);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(err).toMatchObject({ name: "RenderError", failure: "host_unresponsive" });
  expect(err.message).toContain("didn't answer");
});

test("a host that answers, then stalls mid-reply, fails within the deadline too", async () => {
  const endpoint = host(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"data":"'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const renderer = new RemoteRenderer(endpoint, "t", undefined, { deadlineMs: 300 });
  const started = Date.now();
  const err = await renderer.render(req()).catch((e) => e);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(err).toMatchObject({ name: "RenderError", failure: "host_unresponsive" });
});

test("a host that isn't running says so", async () => {
  const endpoint = host(() => json({}));
  stop?.();
  stop = null;
  const err = await new RemoteRenderer(endpoint).render(req()).catch((e) => e);
  expect(err).toMatchObject({ name: "RenderError", failure: "host_unreachable" });
  expect(err.message).toContain("isn't running");
});

test("a host's error names the step that failed", async () => {
  const endpoint = host(() =>
    json({ error: "The render stalled loading the page.", failure: "timeout", stage: "load" }, 500),
  );
  const err = await new RemoteRenderer(endpoint).render(req()).catch((e) => e);
  expect(err).toMatchObject({ failure: "timeout", stage: "load" });
  expect(err.message).toBe("The render stalled loading the page.");
});

test("an older host's plain-text error still comes through", async () => {
  const endpoint = host(() => new Response("UnknownVizError", { status: 500 }));
  const err = await new RemoteRenderer(endpoint).render(req()).catch((e) => e);
  expect(err).toMatchObject({ failure: "render_error" });
  expect(err.message).toBe("Render host: 500 UnknownVizError");
});

test("an unknown failure from a host is reported as a render error", async () => {
  const endpoint = host(() => json({ error: "?", failure: "/Users/someone/x" }, 500));
  const err = await new RemoteRenderer(endpoint).render(req()).catch((e) => e);
  expect(err.failure).toBe("render_error");
});

test("lint comes back when only the capture failed", async () => {
  const issues = [{ id: "n_p", kind: "clipped-text", message: "text is clipped" }];
  const endpoint = host(() =>
    json({
      data: "",
      mime: "",
      width: 400,
      height: 300,
      contentHeight: 300,
      issues,
      captureError: "The render stalled capturing the image (stopped after 20s).",
    }),
  );
  const out = await new RemoteRenderer(endpoint).render(req()).catch((e) => e);
  expect(out.captureError).toContain("capturing the image");
  expect(out.issues).toEqual(issues);
  expect(out.bytes.length).toBe(0);
});

test("without lint, a failed capture is an error", async () => {
  const endpoint = host(() =>
    json({
      data: "",
      mime: "",
      width: 1,
      height: 1,
      contentHeight: 1,
      issues: [],
      captureError: "x",
    }),
  );
  const err = await new RemoteRenderer(endpoint).render(req(false)).catch((e) => e);
  expect(err).toMatchObject({ failure: "capture_failed", stage: "capture" });
});

test("a render that went on without its fonts says so", async () => {
  const endpoint = host(() =>
    json({
      data: btoa("png"),
      mime: "image/png",
      width: 400,
      height: 300,
      contentHeight: 300,
      issues: [],
      assetsTimedOut: true,
    }),
  );
  const out = await new RemoteRenderer(endpoint).render(req());
  expect(out.assetsTimedOut).toBe(true);
});

test("a host without the session API still can't measure", async () => {
  const endpoint = host(() => new Response("", { status: 404 }));
  const err = await new RemoteRenderer(endpoint)
    .measure({ artboard, tokens: "", ids: ["n_p"] })
    .catch((e) => e);
  expect(err.message).toBe("This render host can't measure layout.");
});

test("the theme goes to the host, so prefers-color-scheme follows it there", async () => {
  const sent: { colorScheme?: string; html: string }[] = [];
  const endpoint = host(async (r) => {
    const body = (await r.json()) as { op?: string; colorScheme?: string; html: string };
    if (body.op && body.op !== "open") return json({});
    sent.push(body);
    if (body.op) return json({ session: "s1" });
    return json({
      data: btoa("png"),
      mime: "image/png",
      width: 400,
      height: 300,
      contentHeight: 300,
      issues: [],
    });
  });
  const remote = new RemoteRenderer(endpoint);
  await remote.render({ ...req(), colorScheme: "dark" });
  await remote.measure({ artboard, tokens: "", ids: ["n_p"], colorScheme: "dark" }).catch(() => {});
  expect(sent.map((s) => s.colorScheme)).toEqual(["dark", "dark"]);
  expect(sent[0]!.html).toContain(":root{color-scheme:dark}");
});

test("a film given up on while its session opens never starts", async () => {
  const ops: string[] = [];
  const stop = new AbortController();
  const endpoint = host(async (r) => {
    const body = (await r.json()) as { op: string };
    ops.push(body.op);
    if (body.op === "open") {
      // Given up on while the host is still opening the page.
      stop.abort();
      return json({ session: "s1" });
    }
    return json({});
  });
  const err = await new RemoteRenderer(endpoint)
    .loop({ artboard, tokens: "", scale: 1, signal: stop.signal })
    .catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(ops).not.toContain("eval");
  expect(ops).toContain("close");
});
