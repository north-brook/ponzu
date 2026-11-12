import { expect, test } from "bun:test";
import { shouldWelcome1x } from "./welcome-1x.tsx";

/*
 * The studio's half of the welcome from Ponzu 1.x: it shows the sheet only when the shell says a
 * plain yes. The shell's half (shown once, never in smoke) is apps/desktop/src/welcome-1x.test.ts.
 */

test("the sheet shows only when the shell answers true", async () => {
  expect(await shouldWelcome1x({ welcome1x: async () => true })).toBe(true);
  expect(await shouldWelcome1x({ welcome1x: async () => false })).toBe(false);
});

test("no shell, an odd answer or a failed ask never shows it", async () => {
  expect(await shouldWelcome1x({})).toBe(false);
  const odd = async () => ({ ok: true }) as unknown as boolean;
  expect(await shouldWelcome1x({ welcome1x: odd })).toBe(false);
  const failing = async (): Promise<boolean> => {
    throw new Error("No handler registered for 'ponzu:welcome-1x'");
  };
  expect(await shouldWelcome1x({ welcome1x: failing })).toBe(false);
});
