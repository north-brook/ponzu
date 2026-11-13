/*
 * Writes src/cloud/remote-catalog.json: the canvas tools a person's own agent drives a canvas
 * with, as Ponzu's MCP lists them (docs/cloud.md, "Driving a canvas"). The API lists them from
 * this file rather than loading the tools, which bring the renderer with them. A test holds the
 * file to the tools: run this after changing one.
 *
 *   bun packages/tools/scripts/remote-catalog.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { remoteCatalog } from "../src/cloud/remote.ts";

const out = join(import.meta.dir, "../src/cloud/remote-catalog.json");
writeFileSync(out, `${JSON.stringify(remoteCatalog(), null, 2)}\n`);
console.log(`wrote ${out}`);
