import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePushData } from "@ponzu/core/push";
import { fakeCloud } from "../../lib/cloud/backend.fake";
import { tapOf } from "../../lib/push/payload";

/*
 * The pings the simulator run sends (`xcrun simctl push`, run.sh) name the fake's canvases and
 * questions by id. The fake makes its ids in order, so a fresh launch seeded `pings` always has
 * the same ones: this checks the files still name them, and that each is a ping Expo would
 * deliver (PushData v1 under `body`, the words under `aps`).
 */

const DIR = import.meta.dir;
const files = readdirSync(DIR).filter((name) => name.endsWith(".apns"));

async function seeded() {
  const cloud = fakeCloud({ storage: null });
  await cloud.prepare();
  cloud.seed("pings");
  // Seeding stocks the asks, then signs Maya in.
  for (let i = 0; i < 100 && cloud.session.getState().status !== "signed_in"; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const canvases = [...cloud.world.fake.canvases.values()];
  const named = (name: string) => canvases.find((c) => c.sequencer.doc.name === name)!;
  const pricing = named("Pricing page");
  return {
    pricing: pricing.id,
    onboarding: named("Onboarding").id,
    questions: pricing.questions.map((q) => q.id),
  };
}

test("each simulator ping is one Expo would deliver, naming the fake's own ids", async () => {
  const ids = await seeded();
  expect(files.sort()).toEqual([
    "cold-permission.apns",
    "onboarding-finished.apns",
    "pricing-question.apns",
    "pricing-reply.apns",
  ]);
  for (const file of files) {
    const ping = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    expect(ping["Simulator Target Bundle"]).toBe("design.ponzu.app.dev");
    expect(typeof ping.aps.alert.title).toBe("string");
    expect(typeof ping.aps.alert.body).toBe("string");
    const data = parsePushData(ping.body);
    expect({ file, parsed: data !== null }).toEqual({ file, parsed: true });
    expect([ids.pricing, ids.onboarding]).toContain(data!.c!);
    if (data!.q) expect(ids.questions).toContain(data!.q);
    // As expo-notifications hands it over.
    const tap = tapOf({
      request: { content: { data: ping.body }, trigger: { type: "push", payload: ping } },
    });
    expect(tap.canvasId).toBe(data!.c!);
  }
  const question = JSON.parse(readFileSync(join(DIR, "pricing-question.apns"), "utf8"));
  expect(question.body.q).toBe(ids.questions[0]);
  // The permission, the last of the asks.
  const cold = JSON.parse(readFileSync(join(DIR, "cold-permission.apns"), "utf8"));
  expect(cold.body.q).toBe(ids.questions[2]);
});
