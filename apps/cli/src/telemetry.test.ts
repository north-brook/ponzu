import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostHog } from "posthog-node";

let home: string;
let mod: typeof import("./telemetry.ts");
const file = () => join(home, "telemetry.json");

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "ponzu-home-"));
  process.env.PONZU_HOME = home;
  // A release build's key, so only the person's switches turn it off.
  process.env.PONZU_POSTHOG_KEY = "phc_test";
  for (const k of ["PONZU_TELEMETRY", "DO_NOT_TRACK", "CI"]) delete process.env[k];
  mod = await import("./telemetry.ts");
});

afterAll(async () => {
  delete process.env.PONZU_HOME;
  delete process.env.PONZU_POSTHOG_KEY;
  await rm(home, { recursive: true, force: true });
});

const status = async (arg?: string) => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await mod.telemetryCommand(arg);
    return String(log.mock.calls.at(-1)?.[0]);
  } finally {
    log.mockRestore();
  }
};

const fakeTailscale = async (status: object | null) => {
  const bin = join(home, "tailscale");
  await writeFile(
    bin,
    status ? `#!/bin/sh\necho '${JSON.stringify(status)}'\n` : "#!/bin/sh\nexit 1\n",
  );
  await chmod(bin, 0o755);
  process.env.PONZU_TAILSCALE = bin;
};

const sent = async (
  run: (t: NonNullable<Awaited<ReturnType<typeof mod.startTelemetry>>>) => void | Promise<void>,
) => {
  const capture = spyOn(PostHog.prototype, "capture").mockImplementation(() => {});
  const alias = spyOn(PostHog.prototype, "alias").mockImplementation(() => {});
  try {
    const telemetry = await mod.startTelemetry({ version: "test", command: "serve" });
    if (!telemetry) throw new Error("telemetry is off");
    await run(telemetry);
    await telemetry.shutdown();
    return {
      events: capture.mock.calls.map(([e]) => e),
      aliases: alias.mock.calls.map(([a]) => a),
    };
  } finally {
    capture.mockRestore();
    alias.mockRestore();
    delete process.env.PONZU_TAILSCALE;
  }
};

test("with Tailscale, an install is aliased once to a hash of its owner", async () => {
  await writeFile(file(), JSON.stringify({ id: "install-1" }));
  await fakeTailscale({
    BackendState: "Running",
    Self: { TailscaleIPs: ["100.64.0.1"], UserID: 7 },
  });
  const { events, aliases } = await sent((t) => {
    t.capture("host started", {});
    t.capture("canvas opened", { open_canvases: 1 });
  });
  expect(aliases).toEqual([{ distinctId: mod.ownerHash("7"), alias: "install-1" }]);
  expect(mod.ownerHash("7")).toMatch(/^[0-9a-f]{32}$/);
  expect(events.map((e) => e?.distinctId)).toEqual(["install-1", "install-1"]);
  expect(events[1]?.properties).not.toHaveProperty("$process_person_profile");
});

test("a Mac that signs in to another Tailscale account isn't aliased again", async () => {
  await writeFile(file(), JSON.stringify({ id: "install-1" }));
  const tailnet = (user: number) =>
    fakeTailscale({
      BackendState: "Running",
      Self: { TailscaleIPs: ["100.64.0.1"], UserID: user },
    });
  await tailnet(7);
  try {
    const { aliases } = await sent(async (t) => {
      t.capture("host started", {});
      // The first owner is read and aliased before the account changes.
      const alias = PostHog.prototype.alias as unknown as { mock: { calls: unknown[] } };
      for (let i = 0; i < 200 && !alias.mock.calls.length; i++) await Bun.sleep(5);
      await tailnet(8);
      // Past the owner's re-read.
      setSystemTime(new Date(Date.now() + 11 * 60_000));
      t.capture("canvas opened", { open_canvases: 1 });
    });
    expect(aliases).toEqual([{ distinctId: mod.ownerHash("7"), alias: "install-1" }]);
  } finally {
    setSystemTime();
  }
});

test("without Tailscale, events stay personless and nothing is aliased", async () => {
  await writeFile(file(), JSON.stringify({ id: "install-1" }));
  await fakeTailscale(null);
  const { events, aliases } = await sent((t) => t.capture("host started", {}));
  expect(aliases).toEqual([]);
  expect(events[0]?.properties?.$process_person_profile).toBe(false);
});

test("ponzu telemetry off sticks, and keeps the install id", async () => {
  expect(await status("on")).toContain("Telemetry is on");
  const { id } = JSON.parse(await readFile(file(), "utf8"));
  expect(await status("off")).toContain("Telemetry is off");
  expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ id, enabled: false });
  expect(await mod.startTelemetry({ version: "test", command: "serve" })).toBeNull();
});

test("an unreadable settings file means off, and is left as it is", async () => {
  await writeFile(file(), "{ not json");
  expect(await status()).toContain("can't be read");
  expect(await mod.startTelemetry({ version: "test", command: "serve" })).toBeNull();
  expect(await mod.telemetryNotice()).toBeNull();
  expect(await readFile(file(), "utf8")).toBe("{ not json");
});
