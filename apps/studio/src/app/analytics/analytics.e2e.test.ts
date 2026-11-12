/*
 * PostHog in the studio as it ships, built and in a real Chromium, on Ponzu Cloud in memory, and
 * pointed at a local sink that plays PostHog's ingestion: what is sent, and what is not. Once in
 * each replay mode: `full` records the boards and the thread; `private` records neither, while
 * the window around them stays. Skips where there is no Chrome or Chromium.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { type Browser, chromiumPath, launch, type Page } from "../../../scripts/visual-lib.ts";
import { buildApp, serve, waitUntil } from "../e2e-lib.ts";

setDefaultTimeout(90_000);

const KEY = "phc_e2e_sink";
/** A 1×1 PNG, for a picture of the person's own. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface Sent {
  path: string;
  headers: Record<string, string>;
  events: { event: string; properties: Record<string, unknown>; [key: string]: unknown }[];
}

/** PostHog's body, whichever way the SDK packed it: gzip, base64 in a form, or plain JSON. */
function decode(bytes: Uint8Array): unknown[] {
  if (!bytes.length) return [];
  let text =
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? new TextDecoder().decode(gunzipSync(bytes))
      : new TextDecoder().decode(bytes);
  if (text.startsWith("data=")) {
    text = Buffer.from(decodeURIComponent(text.slice(5)), "base64").toString("utf8");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed;
    const batch = (parsed as { batch?: unknown[] }).batch;
    return batch ?? [parsed];
  } catch {
    return [];
  }
}

/** A local PostHog: answers remote config with recording on, and keeps every batch. */
function postHogSink() {
  const sent: Sent[] = [];
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      const headers = Object.fromEntries(request.headers.entries());
      if (url.pathname.startsWith("/api/")) {
        sent.push({ path: url.pathname, headers, events: [] });
        return Response.json({}, { headers: cors });
      }
      if (url.pathname.includes("/config") || url.pathname.startsWith("/flags")) {
        return Response.json(
          {
            sessionRecording: { endpoint: "/s/", consoleLogRecordingEnabled: true },
            heatmaps: true,
            capturePerformance: { network_timing: true },
            autocaptureExceptions: true,
            // Autocapture runs only once remote config says the project hasn't opted out.
            autocapture_opt_out: false,
            featureFlags: {},
          },
          { headers: cors },
        );
      }
      const events = decode(new Uint8Array(await request.arrayBuffer())) as Sent["events"];
      sent.push({ path: url.pathname, headers, events });
      return Response.json({ status: 1 }, { headers: cors });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    sent,
    events: () => sent.flatMap((s) => s.events),
    stop: () => server.stop(true),
  };
}

describe.skipIf(!chromiumPath)("PostHog in the built studio, against a local sink", () => {
  let dir: string;
  let app: ReturnType<typeof serve>;
  let browser: Browser;

  beforeAll(async () => {
    dir = await buildApp("e2e");
    app = serve(dir);
    browser = await launch();
  });
  afterAll(async () => {
    await browser?.close();
    app?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Signs in as someone whose setup is done, and opens the seeded canvas from the sidebar. */
  async function openCanvas(mode: "full" | "private") {
    const sink = postHogSink();
    // PostHog drops HeadlessChrome as a bot; the app's Electron says it is Chrome and Electron.
    const page: Page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ponzu/2.0.0 Chrome/138.0.0.0 Electron/44.9.3 Safari/537.36",
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    // What the page has sent PostHog and not yet heard back on.
    const pending = new Set<unknown>();
    page.on("request", (r) => r.url().startsWith(sink.url) && pending.add(r));
    page.on("requestfinished", (r) => pending.delete(r));
    page.on("requestfailed", (r) => pending.delete(r));
    // A canvas's files, played here: the in-memory backend serves them at `https://assets.test/`.
    await page.route("https://assets.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(PNG, "base64") }),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(
      ({ host, mode, key }) => {
        // Nor is it driven: the headless browser says it is, which PostHog also takes for a bot.
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
        window.ponzuAnalyticsSetup = {
          key,
          host,
          replay: mode,
          channel: "Ponzu Dev",
          osVersion: "15.1",
          environment: "dev",
          commit: "0123456789abcdef0123456789abcdef01234567",
          launch: { first: true, updatedFrom: null },
          apiUrl: host,
        };
      },
      { host: sink.url, mode, key: KEY },
    );
    await page.goto(app.url);
    await page.waitForSelector('[data-screen="sign-in"]');
    await page.evaluate(() => {
      const fake = window.ponzuFake!;
      const at = new Date().toISOString();
      fake.backend.onboarding.set(fake.me.id, { whereAt: at, iphoneAt: at });
      fake.backend.claude.connect(fake.me.id);
    });
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.getByText("Onboarding flow").first().click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("[data-artboard-host]")].some((host) =>
        host.shadowRoot?.textContent?.includes("Welcome"),
      ),
    );
    await page.getByText("I drew the welcome screen").first().waitFor();
    // A picture of the person's own in the thread, at an address under the canvas's asset key.
    const attachment = await page.evaluate(
      async ({ png }) => {
        const fake = window.ponzuFake!;
        const canvasId = [...fake.backend.canvases.keys()][0]!;
        const api = fake.backend.connect(fake.me).api;
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const upload = await api.canvases.upload(canvasId, {
          name: "my-sketch.png",
          type: "image/png",
          bytes,
        });
        await api.canvases.sendMessage(canvasId, {
          text: "Here is my sketch",
          attachments: [upload.ref!],
        });
        return { canvasId, url: upload.url! };
      },
      { png: PNG },
    );
    await page.waitForFunction((src) => {
      const img = document.querySelector<HTMLImageElement>(`#thread img[src="${src}"]`);
      return !!img?.complete && img.naturalWidth > 0;
    }, attachment.url);
    // A search: its results name the canvases it found, and the boards and comments.
    await page.getByRole("button", { name: "Search" }).first().click();
    await page.keyboard.type("Onboard");
    await page.locator("#search-results [role=option]").first().waitFor();
    // An API request, as the app's own: it carries PostHog's session headers.
    await page.evaluate((host) => fetch(`${host}/api/probe`).catch(() => {}), sink.url);
    // A mark put on the page last. The recorder compresses and sends its frames in order, so a
    // batch with the mark holds, or comes after, every frame of the thread and the search; and
    // once every request the page has made to PostHog is answered, all of them are here.
    const mark = `e2e-mark-${crypto.randomUUID()}`;
    await page.evaluate((mark) => {
      const element = document.createElement("div");
      element.dataset.e2eMark = mark;
      document.body.append(element);
    }, mark);
    await waitUntil(
      async () => pending.size === 0 && snapshotText(sink.events()).includes(mark),
      30_000,
    );
    const meId = await page.evaluate(() => window.ponzuFake!.me.id);
    await page.close();
    sink.stop();
    // Telemetry broke nothing on the way.
    expect(errors).toEqual([]);
    return { sink, requested, meId, attachment };
  }

  /**
   * Every recorded frame, as text. The recorder gzips each snapshot's data into a string of
   * bytes (`compress_events`); unpacked here as PostHog's own ingestion does.
   */
  const snapshotText = (events: Sent["events"]) =>
    events
      .filter((e) => e.event === "$snapshot")
      .flatMap((e) => (e.properties.$snapshot_data as { data?: unknown }[]) ?? [])
      .map((entry) => JSON.stringify(unpack(entry)))
      .join("\n");
  /** Any string of gzipped bytes in `value`, however deep, as the text it holds. */
  const unpack = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.charCodeAt(0) !== 0x1f || value.charCodeAt(1) !== 0x8b) return value;
      const bytes = Uint8Array.from(value, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(gunzipSync(bytes));
    }
    if (Array.isArray(value)) return value.map(unpack);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpack(v)]));
    }
    return value;
  };

  test("full: the app's events, its views as synthetic URLs, and the boards and thread recorded", async () => {
    // Network timing isn't recorded on localhost (PostHog's own rule), so what it keeps of an
    // address is held by privacy.test.ts.
    const { sink, requested, meId } = await openCanvas("full");
    const events = sink.events();
    const names = events.map((e) => e.event);

    // Nothing came from PostHog's CDN or anywhere but the app, the sink and the canvas's files.
    const elsewhere = (url: string) =>
      !url.startsWith(app.url) &&
      !url.startsWith(sink.url) &&
      !url.startsWith("https://assets.test/");
    expect(requested.filter(elsewhere)).toEqual(
      requested.filter((url) => url.startsWith("https://fonts.")),
    );

    expect(names).toContain("app opened");
    expect(events.find((e) => e.event === "app opened")!.properties.first_launch).toBe(true);
    expect(names).toContain("sign in started");
    expect(names).toContain("sign in completed");
    const identify = events.find((e) => e.event === "$identify")!;
    expect(identify.properties.distinct_id ?? identify.distinct_id).toBe(meId);
    const group = events.find((e) => e.event === "$groupidentify")!;
    expect(group.properties.$group_type).toBe("workspace");
    const opened = events.find((e) => e.event === "canvas opened")!;
    expect(opened.properties.via).toBe("sidebar");
    expect(String(opened.properties.canvas_id)).toMatch(/\S/);
    expect(opened.properties.$groups).toBeDefined();

    // Views: synthetic URLs, and the page's own address nowhere in what events say.
    const views = events
      .filter((e) => e.event === "$pageview")
      .map((e) => e.properties.$current_url);
    expect(views).toContain("ponzu://app/sign-in");
    expect(views).toContain("ponzu://app/canvas");
    for (const event of events) {
      expect(String(event.properties.$current_url)).toStartWith("ponzu://app/");
      expect(JSON.stringify(event.properties.$referrer ?? "$direct")).toContain("$direct");
    }
    // Every event says which app, version, build, environment and computer.
    for (const event of events.filter((e) => !e.event.startsWith("$"))) {
      expect(event.properties).toMatchObject({
        channel: "Ponzu Dev",
        os_version: "15.1",
        environment: "dev",
        app_commit: "0123456789abcdef0123456789abcdef01234567",
      });
    }
    // Autocapture keeps no element's words, nor its labels: the sidebar row clicked to open the
    // canvas has the canvas's name in its `aria-label`.
    const clicks = events.filter((e) => e.event === "$autocapture");
    expect(clicks.length).toBeGreaterThan(0);
    for (const click of clicks) {
      expect(JSON.stringify(click.properties)).not.toContain("Onboarding flow");
      expect(JSON.stringify(click.properties)).not.toContain("onboarding-flow");
    }

    // The API heard the session: its request carried the session id the events have.
    const probe = sink.sent.find((s) => s.path === "/api/probe")!;
    const session = probe.headers["x-posthog-session-id"];
    expect(session).toBeTruthy();
    expect(events.some((e) => e.properties.$session_id === session)).toBe(true);

    // Recorded in full: the board's own words and the thread's.
    const recorded = snapshotText(events);
    expect(recorded).toContain("Welcome");
    expect(recorded).toContain("I drew the welcome screen");
    expect(recorded).toContain("Here is my sketch");
    expect(recorded).toContain("ponzu://app/");
  });

  test("with no project, nothing of PostHog is loaded, and the app runs as it did", async () => {
    const page: Page = await browser.newPage();
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    await page.goto(app.url);
    await page.waitForSelector('[data-screen="sign-in"]');
    await page.waitForTimeout(500);
    const scripts = requested.filter((url) => url.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((url) => /posthog/i.test(url))).toEqual([]);
    expect(requested.filter((url) => !url.startsWith(app.url) && !url.includes("fonts."))).toEqual(
      [],
    );
    await page.close();
  });

  test("private: the window and how it is used, without the boards or the thread's words", async () => {
    const { sink, attachment } = await openCanvas("private");
    const events = sink.events();
    const recorded = snapshotText(events);
    expect(recorded.length).toBeGreaterThan(1000);
    // The chrome is there: the sidebar and the thread's pane as boxes, blocked boards as boxes.
    expect(recorded).toContain("sidebar");
    expect(recorded).toContain("rr_width");
    // A canvas's words and pixels are not.
    expect(recorded).not.toContain("Welcome");
    expect(recorded).not.toContain("I drew the welcome screen");
    expect(recorded).not.toContain("Onboarding flow");
    // Nor the search's results: the canvas it found, its match highlighted apart from the rest.
    expect(recorded).not.toContain("ing flow");
    // Nor the person's picture, nor the address that would fetch it.
    expect(recorded).not.toContain("Here is my sketch");
    expect(recorded).not.toContain(attachment.url);
    expect(recorded).not.toContain(`assets.test/${attachment.canvasId}`);
    expect(events.map((e) => e.event)).toContain("canvas opened");
  });
});
