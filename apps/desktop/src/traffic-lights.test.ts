import { expect, test } from "bun:test";
import { CHROME, trafficLights } from "./traffic-lights.ts";

// The sidebar toggle beside the lights is centred on the chrome: so are they.
const centre = (version: string, height: number) => trafficLights(version).y + height / 2;

test("the chrome is as tall as the studio draws it", async () => {
  const source = await Bun.file(
    new URL("../../studio/src/cloud/window/app-window.tsx", import.meta.url),
  ).text();
  expect(source).toContain(`app-drag flex h-[${CHROME}px] `);
});

test("the lights sit centred on the chrome on every macOS, and a version it cannot read is a current one", () => {
  // macOS 26 and later draw them 14px tall, an older macOS 12.
  for (const [version, height] of [
    ["26.0", 14],
    ["27.0.1", 14],
    ["15.6.1", 12],
    ["14.0", 12],
    ["", 14],
  ] as const) {
    expect({ version, centre: centre(version, height) }).toEqual({ version, centre: CHROME / 2 });
  }
  expect(trafficLights("").x).toBe(16);
});
