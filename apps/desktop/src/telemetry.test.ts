import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { gunzipSync } from "node:zlib";
import { configFor, posthogFrom } from "./config.ts";
import { contentSecurityPolicy } from "./csp.ts";
import { recordLaunch } from "./launches.ts";
import { scrubPaths, startMainTelemetry } from "./main-telemetry.ts";
import { telemetryOffBecause } from "./telemetry-consent.ts";

const KEY = "phc_test_project";
const baked = { key: KEY, host: "", replay: "" };

test("a build reports to the project it was built for, and nothing without a key", () => {
  expect(configFor(true, {}, false, "release", baked).posthog).toEqual({
    key: KEY,
    host: "https://us.i.posthog.com",
    replay: "private",
  });
  expect(
    configFor(true, {}, false, "release", { key: "", host: "", replay: "" }).posthog,
  ).toBeNull();
  // A test build, which spare and CI drive, reports nothing whatever it was given.
  expect(configFor(true, {}, true, "release", baked).posthog).toBeNull();
  // A packaged build ignores the environment; a development build takes it.
  const env = { PONZU_POSTHOG_KEY: "phc_other", PONZU_POSTHOG_REPLAY: "full" };
  expect(configFor(true, env, false, "release", baked).posthog?.key).toBe(KEY);
  expect(configFor(false, env, false, "release", baked).posthog).toMatchObject({
    key: "phc_other",
    replay: "full",
  });
  expect(
    configFor(false, {}, false, "release", { key: "", host: "", replay: "" }).posthog,
  ).toBeNull();
});

test("a key or host that doesn't parse switches nothing on", () => {
  expect(posthogFrom("not-a-key", "", "")).toBeNull();
  expect(posthogFrom(KEY, "http://example.com", "")).toBeNull();
  expect(posthogFrom(KEY, "http://127.0.0.1:4318", "full")).toEqual({
    key: KEY,
    host: "http://127.0.0.1:4318",
    replay: "full",
  });
  expect(posthogFrom(KEY, "", "anything")?.replay).toBe("private");
});

function connectSrc(posthog: { host: string } | null): string[] {
  const policy = contentSecurityPolicy({ ...configFor(true, {}, false), posthog });
  const directive = policy.split("; ").find((d) => d.startsWith("connect-src "))!;
  return directive.split(" ").slice(1);
}

test("the policy reaches PostHog only when the window reports, and runs none of its scripts", () => {
  expect(connectSrc(null).join(" ")).not.toContain("posthog");
  const on = connectSrc({ host: "https://us.i.posthog.com" });
  expect(on).toContain("https://us.i.posthog.com");
  expect(on).toContain("https://us-assets.i.posthog.com");
  expect(on.join(" ")).not.toContain("*");
  const policy = contentSecurityPolicy({
    ...configFor(true, {}, false),
    posthog: { host: "https://us.i.posthog.com" },
  });
  expect(policy).toContain("script-src 'self';");
  expect(policy).toContain("worker-src 'self' blob:");
  // A project of its own host: that host and nothing more.
  expect(
    connectSrc({ host: "https://ph.example.com" }).filter((s) => s.includes("example")),
  ).toEqual(["https://ph.example.com"]);
});

test("whoever turned 1.x's telemetry off stays off, the ways they could say it", () => {
  const none = () => {
    throw Object.assign(new Error("no file"), { code: "ENOENT" });
  };
  expect(telemetryOffBecause({}, "/home/maya", none)).toBeNull();
  expect(telemetryOffBecause({ PONZU_TELEMETRY: "0" }, "/home/maya", none)).toContain(
    "PONZU_TELEMETRY",
  );
  expect(telemetryOffBecause({ PONZU_TELEMETRY: "1" }, "/home/maya", none)).toBeNull();
  expect(telemetryOffBecause({ DO_NOT_TRACK: "1" }, "/home/maya", none)).toContain("DO_NOT_TRACK");
  expect(telemetryOffBecause({ DO_NOT_TRACK: "0" }, "/home/maya", none)).toBeNull();
  expect(telemetryOffBecause({ CI: "true" }, "/home/maya", none)).toContain("CI");
  const file = (text: string) => (path: string) => {
    expect(path).toBe("/home/maya/.ponzu/telemetry.json");
    return text;
  };
  expect(telemetryOffBecause({}, "/home/maya", file('{"id":"x","enabled":false}'))).toContain(
    "ponzu telemetry off",
  );
  expect(telemetryOffBecause({}, "/home/maya", file('{"id":"x","enabled":true}'))).toBeNull();
  expect(telemetryOffBecause({}, "/home/maya", file("{not json"))).toContain("can't be read");
});

test("a launch knows whether it is the first, and what version it was updated from", () => {
  const files = new Map<string, string>();
  const io = {
    read: (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    write: (path: string, text: string) => void files.set(path, text),
  };
  expect(recordLaunch("/data/launches.json", "2.0.0", io)).toEqual({
    first: true,
    updatedFrom: null,
  });
  expect(recordLaunch("/data/launches.json", "2.0.0", io)).toEqual({
    first: false,
    updatedFrom: null,
  });
  expect(recordLaunch("/data/launches.json", "2.1.0", io)).toEqual({
    first: false,
    updatedFrom: "2.0.0",
  });
  // A folder that can't be written only costs the next launch the answer.
  const readOnly = {
    read: io.read,
    write: () => {
      throw new Error("EROFS");
    },
  };
  expect(recordLaunch("/data/launches.json", "2.2.0", readOnly).updatedFrom).toBe("2.1.0");
});

test("a path names the home folder nowhere", () => {
  const event = {
    message: "ENOENT: /Users/maya/Library/x.json",
    frames: [{ filename: "/Users/maya/Applications/Ponzu.app/main.cjs" }],
  };
  expect(JSON.stringify(scrubPaths(event, "/Users/maya"))).not.toContain("/Users/maya");
  expect(scrubPaths(event, "/Users/maya").frames[0]!.filename).toBe(
    "~/Applications/Ponzu.app/main.cjs",
  );
});

/** A capturing fake of PostHog's ingestion: every batch it was sent, decoded. */
function sink() {
  const events: Record<string, unknown>[] = [];
  const fetch = async (
    url: string,
    options: { body?: unknown; headers?: Record<string, string> },
  ) => {
    let body = options.body as string | Uint8Array | Blob | undefined;
    if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer());
    const text =
      typeof body === "string"
        ? body
        : body
          ? new TextDecoder().decode(body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body)
          : "";
    if (url.includes("/batch")) {
      events.push(...(JSON.parse(text) as { batch: Record<string, unknown>[] }).batch);
    }
    return { status: 200, text: async () => "{}", json: async () => ({}) };
  };
  return { events, fetch };
}

test("the main process's uncaught errors go to PostHog as the signed-in person, and change nothing else", async () => {
  const { events, fetch } = sink();
  const process = new EventEmitter();
  let user: string | null = "usr_1";
  const telemetry = startMainTelemetry({
    posthog: { key: KEY, host: "https://us.i.posthog.com", replay: "private" },
    properties: { app_version: "2.0.0", channel: "Ponzu", platform: "darwin", os_version: "15.1" },
    userId: () => user,
    home: "/Users/maya",
    fetch: fetch as never,
    process,
  });
  // Only a monitor: Electron's own uncaught-exception handling (its dialog) is left as it is.
  expect(process.listenerCount("uncaughtException")).toBe(0);
  expect(process.listenerCount("unhandledRejection")).toBe(0);
  process.emit("uncaughtExceptionMonitor", new Error("boom in /Users/maya/x"), "uncaughtException");
  user = null;
  process.emit("uncaughtExceptionMonitor", new Error("rejected"), "unhandledRejection");
  await telemetry.shutdown();
  telemetry.stop();
  expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(0);

  expect(events.map((e) => e.event)).toEqual(["$exception", "$exception"]);
  const [mine, nobody] = events as { distinct_id: string; properties: Record<string, unknown> }[];
  expect(mine!.distinct_id).toBe("usr_1");
  expect(mine!.properties).toMatchObject({
    app_version: "2.0.0",
    channel: "Ponzu",
    origin: "uncaughtException",
  });
  expect(JSON.stringify(mine)).not.toContain("/Users/maya");
  expect(nobody!.distinct_id).not.toBe("usr_1");
  expect(nobody!.properties.$process_person_profile).toBe(false);
});

test("PostHog out of reach costs a quit two seconds at most, and throws nothing", async () => {
  const process = new EventEmitter();
  const telemetry = startMainTelemetry({
    posthog: { key: KEY, host: "https://us.i.posthog.com", replay: "private" },
    properties: {},
    userId: () => null,
    home: "/Users/maya",
    fetch: (() => new Promise(() => {})) as never,
    process,
  });
  process.emit("uncaughtExceptionMonitor", new Error("x"), "uncaughtException");
  const started = Date.now();
  await telemetry.shutdown(300);
  expect(Date.now() - started).toBeLessThan(1500);
  telemetry.stop();
});
