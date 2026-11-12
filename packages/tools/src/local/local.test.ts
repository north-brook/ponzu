import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Design, MemoryAdapter } from "@ponzu/store";
import { EventHub, PresenceHub, type ToolContext, type Workspace } from "../context.ts";
import { jsonSchema, runTool } from "../define.ts";
import { getTool, tools } from "./tools.ts";

/*
 * The local server answers any caller on its machine, and on its network when it is told to
 * listen there. A path such a caller passes names a file of the server's, so no local tool
 * may read one: that is the cloud's, where the tools run beside the agent in its own sandbox.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("the only local tools that take a path are the two that write to it", () => {
  const withPath = tools
    .filter((def) => "path" in (jsonSchema(def) as { properties: object }).properties)
    .map((def) => def.name);
  expect(withPath.sort()).toEqual(["create_file", "export"]);
  expect((jsonSchema(getTool("write_html")!) as { required: string[] }).required).toEqual([
    "target",
    "html",
  ]);
});

test("a path passed to write_html or create_artboard is never read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-local-tools-"));
  dirs.push(dir);
  const key = join(dir, "id_ed25519");
  await writeFile(key, "-----BEGIN OPENSSH PRIVATE KEY-----");

  const design = await Design.open(
    new MemoryAdapter({
      "design.json": JSON.stringify({
        ponzu: 1,
        name: "Fern",
        pages: [{ id: "pg_home", name: "Home" }],
      }),
      "pages/home/hero.html": `<section data-artboard data-id="ab_hero" data-name="Hero" data-x="0" data-y="0" style="width:800px;height:600px">\n<div data-id="n_card"></div>\n</section>\n`,
    }),
    { saveDelay: 0 },
  );
  const ws: Workspace = {
    canvases: () => [{ key: "fern", canvas: design }],
    resolve: async () => ({ key: "fern", canvas: design }),
    events: new EventHub(),
    presence: new PresenceHub(),
  };
  const ctx: ToolContext = { ws, caller: { id: "t", author: { kind: "agent", name: "test" } } };

  const wrote = await runTool(getTool("write_html")!, { target: "n_card", path: key }, ctx);
  expect(wrote.isError).toBe(true);
  expect(wrote.text).toStartWith("Invalid arguments for write_html: html:");
  const made = await runTool(getTool("create_artboard")!, { name: "Keys", path: key }, ctx);
  expect(made.isError).toBeFalsy();
  expect(JSON.stringify(design.doc)).not.toContain("PRIVATE KEY");
  expect((await runTool(getTool("get_html")!, { id: "n_card" }, ctx)).text).toBe(
    '<div data-id="n_card"></div>',
  );
});
