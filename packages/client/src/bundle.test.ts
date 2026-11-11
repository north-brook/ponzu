import { expect, test } from "bun:test";
import { builtinModules } from "node:module";

/*
 * The phone bundles this package with Metro for Hermes: no Node, no DOM in the core, and none
 * of the API's runtime. A bundle made the way Expo resolves (the `react-native` condition, for
 * a browser-like target) holds the package to that. What Hermes itself lacks is in the README
 * ("On the phone").
 */

const NODE = new RegExp(`^(node:|(${builtinModules.join("|")})(/|$))`);

for (const entry of ["index.ts", "react.ts", "testing/index.ts"]) {
  test(`${entry} bundles for React Native with nothing from Node or the API's runtime`, async () => {
    // Bun would quietly stand in for a Node module in a browser bundle: catch the import itself.
    const fromNode: string[] = [];
    const built = await Bun.build({
      entrypoints: [`${import.meta.dir}/${entry}`],
      target: "browser",
      conditions: ["react-native"],
      external: ["react"],
      plugins: [
        {
          name: "no-node",
          setup(build) {
            build.onResolve({ filter: NODE }, ({ path, importer }) => {
              fromNode.push(`${path} from ${importer}`);
              return { path, external: true };
            });
          },
        },
      ],
    });
    expect(built.success).toBe(true);
    expect(fromNode).toEqual([]);
    const code = await built.outputs[0]!.text();
    // What a slip into the API's or the database's code would bring along.
    expect(code).not.toContain("ZodError");
    expect(code).not.toContain("drizzle");
  });
}
