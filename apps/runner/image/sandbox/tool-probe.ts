/*
 * The canvas tools as the runner hosts them, run in a sandbox made from the image with the
 * runner's own user, group and capability (checks.ts starts it under systemd-run with the
 * unit's settings), against links and paths the agent's user could plant: does a tool hand the
 * agent anything the agent could not read itself, or write where it could not write?
 *
 *   bun tool-probe.js <dir the agent planted links in>
 *
 * Prints one JSON line: for each read, whether the tool took the file and whether anything of
 * the target came back; for each write, the tool's answer (checks.ts looks for the file).
 */
import { emptyDoc } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import { getCloudTool, localFiles, runTool } from "@ponzu/tools";
import { memoryCloud } from "../../../../packages/tools/src/cloud/testing.ts";
import { agentFiles } from "../../src/files.ts";

const [dir] = process.argv.slice(2);
if (!dir) throw new Error("say where the links are");

// As main.ts does: the image's unit names the wrapper, and without one the runner's access is used.
const asAgent = process.env.PONZU_AS_AGENT;
const files = asAgent ? agentFiles(asAgent, { PATH: process.env.PATH }) : localFiles;
const renderer: Renderer = {
  render: async () => ({
    bytes: new TextEncoder().encode("PROBE-EXPORT"),
    mime: "image/png",
    width: 10,
    height: 10,
    contentHeight: 10,
    issues: [],
  }),
  close: async () => {},
};
const cloud = memoryCloud(emptyDoc("Probe"), { files, renderer });
const call = (name: string, args: unknown) => runTool(getCloudTool(name)!, args, cloud.ctx);

const board = await call("create_artboard", { name: "Probe", html: "<p>probe</p>" });
const { id } = board.data as { id: string };

const reads: Record<string, { taken: boolean; leaked: boolean; said: string }> = {};
for (const name of ["env-file", "runner-environ", "shadow", "runner-home"]) {
  const before = JSON.stringify(cloud.replica.doc);
  const r = await call("write_html", { target: id, path: `${dir}/${name}.html` });
  const after = JSON.stringify(cloud.replica.doc);
  // The probe's own board says "probe"; anything else in it came from the file.
  reads[name] = {
    taken: !r.isError,
    leaked: after !== before || /PONZU_|ANTHROPIC|root:|token/i.test(r.text),
    said: r.text.slice(0, 160),
  };
}
const asset = await call("add_asset", { path: `${dir}/env-file.html`, name: "env.png" });
const writes: Record<string, { taken: boolean; said: string }> = {};
for (const [name, path] of [
  ["through-link", `${dir}/deputy.png`],
  ["runner-home", "/home/user/ponzu-probe-direct.png"],
]) {
  const r = await call("export", { id, path });
  writes[name!] = { taken: !r.isError, said: r.text.slice(0, 160) };
}
console.log(
  JSON.stringify({
    asAgent: asAgent ?? null,
    reads,
    asset: { taken: !asset.isError, stored: cloud.host.assets.size },
    writes,
  }),
);
cloud.close();
process.exit(0);
