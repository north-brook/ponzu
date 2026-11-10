import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the types entry reaches no package, so a client bundle gains no driver from it", async () => {
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./types.ts", import.meta.url))],
    // Anything imported from a package would be left in the output as an import.
    packages: "external",
  });

  expect(built.success).toBe(true);
  const [output] = built.outputs;
  expect(new Bun.Transpiler().scanImports(await output!.text())).toEqual([]);
});

test("the types entry carries the lists and the head a client needs", async () => {
  const types = await import("./types.ts");

  expect(types.AGENT_STATES).toContain("needs_you");
  expect(types.EVENT_PRIORITIES).toEqual(["now", "next", "later"]);
  expect(types.DESIGN_HEAD_COLUMNS).toContain("seq");
  expect(typeof types.toDesignHead).toBe("function");
});
