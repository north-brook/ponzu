import { expect, test } from "bun:test";
import {
  baseImage,
  imageInputs,
  inputsHash,
  pins,
  REPOSITORY,
  readCurrent,
  runnerRequires,
  tagOf,
  upstreamPins,
} from "./image.ts";

const current = readCurrent();

test("current.json records the image these inputs make (it is not stale)", () => {
  const inputs = inputsHash(imageInputs());
  // A change to the Dockerfile, provision.sh, pins.json, the font manifest or libexec/ needs a
  // new image: bun apps/runner/image/build.ts (or the image workflow) records it here.
  expect(current.inputs).toBe(inputs);
  expect(current.tag).toBe(tagOf(inputs));
  expect(current.image).toBe(`${REPOSITORY}@${current.digest}`);
  expect(current.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(current.repository.endsWith(`/${REPOSITORY}`)).toBe(true);
  expect(current.base).toBe(baseImage());
  expect(Date.parse(current.checkedAt)).toBeGreaterThanOrEqual(Date.parse(current.builtAt));
});

test("current.json's pins are pins.json's", () => {
  expect(current.pins).toEqual(pins);
});

test("the runner bundle requires the Claude Code and playwright-core pins.json installs", () => {
  expect(runnerRequires()).toEqual({
    claude: pins.claudeVersion,
    playwrightCore: pins.playwrightCoreVersion,
  });
});

test("pins.json agrees with what pins each version: packageManager, the Agent SDK, playwright-core", () => {
  const upstream = upstreamPins();
  expect(upstream.headlessShellVersion).toBeDefined();
  for (const [key, value] of Object.entries(upstream))
    expect({ [key]: pins[key as keyof typeof pins] }).toEqual({ [key]: value });
});

test("the same inputs hash the same in any order, and any change makes another tag", () => {
  const inputs = imageInputs();
  expect(inputs.map((i) => i.path)).toEqual([
    "Dockerfile",
    "provision.sh",
    "pins.json",
    "sandbox-fonts.json",
    "libexec/bundle-fits",
    "libexec/ponzu-start",
    "libexec/ponzu-stop",
  ]);
  const hash = inputsHash(inputs);
  expect(inputsHash([...inputs].reverse())).toBe(hash);
  const changed = inputs.map((i) =>
    i.path === "provision.sh" ? { ...i, bytes: new TextEncoder().encode("echo other") } : i,
  );
  expect(inputsHash(changed)).not.toBe(hash);
});

test("the image commands are the ones the design gives", () => {
  const read = (name: string) =>
    new TextDecoder().decode(imageInputs().find((i) => i.path === `libexec/${name}`)!.bytes);
  const start = read("ponzu-start");
  expect(start).toContain("dir=/opt/ponzu/runners/$PONZU_RUNNER_BUNDLE");
  expect(start).toContain('sha256sum --check --quiet || { echo "bundle hash"');
  expect(start).toContain("exit 78");
  expect(start).toContain(
    'exec /usr/bin/flock -n /run/ponzu-supervisor.lock /opt/ponzu/bin/bun "$dir/supervise.js" >>"$log" 2>&1',
  );
  // The runner token reaches curl on its stdin, never in an argument.
  expect(start).toContain("-H @-");
  const stop = read("ponzu-stop");
  expect(stop).toContain(
    "pkill -TERM -f '^/opt/ponzu/bin/bun /opt/ponzu/runners/[^ ]*/supervise.js'",
  );
  expect(stop).toContain("/usr/bin/flock -w 25 /run/ponzu-supervisor.lock true");
});
