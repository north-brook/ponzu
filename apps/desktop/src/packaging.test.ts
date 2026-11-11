import { expect, test } from "bun:test";
import manifest from "../package.json";

test("the packaged app can't be run as Node or opened to an inspector, and loads only its own asar", () => {
  // Each of these would hand another program on the computer the signed-in session.
  expect(manifest.build.electronFuses).toMatchObject({
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  });
});
