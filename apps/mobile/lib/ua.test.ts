import { expect, test } from "bun:test";
import { userAgent } from "./ua-string";

test("the server can tell the phone by its User-Agent", () => {
  const ua = userAgent("1.2.3", "26.1");
  expect(ua).toBe("Ponzu-iOS/1.2.3 (iPhone; iOS 26.1)");
  // isPhone in packages/server/src/serve.ts.
  expect(/\bPonzu-iOS\//.test(ua)).toBe(true);
});
