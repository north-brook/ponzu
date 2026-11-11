/*
 * Builds the main process and the preload into dist/. `PONZU_TEST_BUILD=1` makes a test build
 * (src/config.ts): the real app, which also honours PONZU_SESSION_FILE and a remote debugging
 * port, for spare and CI to drive it signed in. The release workflow never sets it.
 * `PONZU_VARIANT=preview` builds Ponzu Preview's (scripts/package-preview.ts sets it).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const testBuild = process.env.PONZU_TEST_BUILD === "1";
const variant = process.env.PONZU_VARIANT || "release";
if (variant !== "release" && variant !== "preview") {
  console.error(`PONZU_VARIANT is "release" or "preview", not "${variant}".`);
  process.exit(1);
}
rmSync(join(root, "dist"), { recursive: true, force: true });

for (const entry of ["main", "preload"]) {
  const built = await Bun.build({
    entrypoints: [join(root, "src", `${entry}.ts`)],
    outdir: join(root, "dist"),
    naming: `${entry}.cjs`,
    target: "node",
    format: "cjs",
    external: ["electron"],
    define: {
      PONZU_TEST_BUILD: JSON.stringify(testBuild),
      PONZU_VARIANT: JSON.stringify(variant),
    },
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }
}
if (testBuild) console.log("A test build: it takes PONZU_SESSION_FILE and remote debugging.");
if (variant === "preview") console.log("Ponzu Preview: its own name, data, keychain and links.");
