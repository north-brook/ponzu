import { expect, test } from "bun:test";
import { MATERIAL, SHELL, shellGround } from "./shell-ground.ts";

const tokens = await Bun.file(
  new URL("../../studio/src/cloud/styles/tokens.css", import.meta.url),
).text();

test("a Mac's window is the system's material, with no colour of its own over it", () => {
  const ground = shellGround("darwin", false);
  expect(ground.glass).toBe(true);
  expect(ground.options).toMatchObject(MATERIAL);
  // A backgroundColor would paint the page's ground over the material.
  expect(ground.options.backgroundColor).toBeUndefined();
  expect(ground.options.transparent).toBeUndefined();
});

test("Windows and Linux get the solid shell in the system's appearance", () => {
  for (const platform of ["win32", "linux"] as const) {
    expect(shellGround(platform, false)).toEqual({
      glass: false,
      options: { backgroundColor: SHELL.light },
    });
    expect(shellGround(platform, true).options.backgroundColor).toBe(SHELL.dark);
    expect(shellGround(platform, true).options.vibrancy).toBeUndefined();
  }
});

test("the solid shell is the studio's --c-chrome", () => {
  const chrome = tokens.match(/--c-chrome:\s*light-dark\(([^,]+),\s*([^)]+)\);/);
  expect(chrome?.slice(1)).toEqual([SHELL.light, SHELL.dark]);
});
