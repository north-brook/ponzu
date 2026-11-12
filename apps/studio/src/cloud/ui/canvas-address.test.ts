import { expect, test } from "bun:test";
import { parseCanvasAddress } from "./canvas-address.ts";

/*
 * The address a canvas had before canvases had their name, /designs/<id>, still in pull requests
 * and threads written then. It is read the same as /canvases/<id>, with the same strictness
 * (place-link.test.tsx has the rest); nothing writes it any more.
 */

test("an address from before canvases had their name is read the same", () => {
  expect(parseCanvasAddress("https://ponzu.design/designs/des_7k2m9x4q0c8v5n1t")).toEqual({
    canvasId: "des_7k2m9x4q0c8v5n1t",
  });
  expect(parseCanvasAddress("https://ponzu.design/designs/cnv_1?artboard=ab_x1")).toEqual({
    canvasId: "cnv_1",
    artboard: "ab_x1",
  });
});

test("the old form is held to the same rules as the new", () => {
  for (const href of [
    "http://ponzu.design/designs/des_1",
    "https://evil.test/designs/des_1",
    "https://ponzu.design/designs/des_1/settings",
    "https://ponzu.design/designs/",
    "https://ponzu.design/designs/des 1",
  ]) {
    expect(parseCanvasAddress(href)).toBeNull();
  }
});
