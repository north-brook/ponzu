import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyDoc } from "@ponzu/core";
import { runTool } from "../define.ts";
import { getRemoteTool, remoteCatalog, remoteTools } from "./remote.ts";
import { type MemoryCloud, memoryCloud } from "./testing.ts";
import { cloudTools } from "./tools.ts";

/*
 * The canvas tools a person's own agent drives a canvas with (docs/cloud.md, "Driving a
 * canvas"): the cloud's, without a path anywhere, and the catalogue the API lists them from.
 */

const open: MemoryCloud[] = [];
afterEach(() => {
  for (const cloud of open.splice(0)) cloud.close();
});

function setup() {
  const cloud = memoryCloud(emptyDoc("Fern"));
  open.push(cloud);
  const call = (name: string, args: unknown = {}) => runTool(getRemoteTool(name)!, args, cloud.ctx);
  return { ...cloud, call };
}

test("they are the cloud's tools, in the cloud's order, and none takes a path", () => {
  expect(remoteTools.map((def) => def.name)).toEqual(cloudTools.map((def) => def.name));
  for (const def of remoteTools) expect(Object.keys(def.input)).not.toContain("path");
});

test("the catalogue the API lists them from is the tools as they are", () => {
  const file = JSON.parse(readFileSync(join(import.meta.dir, "remote-catalog.json"), "utf8"));
  // Run `bun packages/tools/scripts/remote-catalog.ts` after changing a tool.
  expect(file).toEqual(JSON.parse(JSON.stringify(remoteCatalog())));
});

test("add_asset takes the bytes in the call, and holds them to what the name says", async () => {
  const { call, host } = setup();
  const png = Buffer.from("\x89PNG\r\n\x1a\npixels", "latin1");
  const added = await call("add_asset", { name: "logo.png", data: png.toString("base64") });
  expect(added.data).toEqual({ ref: "assets/logo.png" });
  expect(host.assets.get("assets/logo.png")?.mime).toBe("image/png");

  const both = await call("add_asset", { name: "x.png", data: "AA==", url: "https://x.test/a" });
  expect(both.isError).toBe(true);
  expect(both.text).toContain("one of the two");

  const notPng = await call("add_asset", {
    name: "logo.png",
    data: Buffer.from("<html>Not found</html>").toString("base64"),
  });
  expect(notPng.isError).toBe(true);
  expect(notPng.text).toContain("isn't a PNG image");

  const plain = await call("add_asset", { name: "logo.png", url: "http://x.test/a.png" });
  expect(plain.text).toContain("Only an https address");
});
