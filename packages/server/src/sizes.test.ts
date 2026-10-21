import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalWorkspace, serve } from "./index.ts";

// Agents send sizes as JSON numbers or as numeric strings; both must be stored
// as lengths the browser accepts, or the artboard collapses to its content.

let dir: string;
let ws: LocalWorkspace;
let server: ReturnType<typeof serve>;
let client: Client;

const text = (r: any) =>
  (r.content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-sizes-"));
  ws = new LocalWorkspace({ cwd: dir });
  server = serve(ws, { port: 0 });
  client = new Client({ name: "claude-code-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)),
  );
});

afterAll(async () => {
  await client.close();
  await ws.closeAll();
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test("artboard sizes given as plain numbers keep their px on every path", async () => {
  const file = "sizes.design";
  await client.callTool({ name: "create_file", arguments: { path: file } });
  const sizeOf = async (id: string) => {
    const { design } = await ws.resolve(file);
    const s = design.doc.pages[0]!.artboards.find((a) => a.id === id)!.root.style;
    return `${s.width}×${s.height}`;
  };

  // The first artboard of a new file, sizes as strings, plus a style object.
  const first = await client.callTool({
    name: "create_artboard",
    arguments: {
      file,
      name: "Desktop",
      width: "1440",
      height: "900",
      style: { padding: "24", minHeight: "900", opacity: "1" },
    },
  });
  expect(text(first)).toContain("1440px×900px");
  const abId = /artboard (ab_\w+)/.exec(text(first))![1]!;
  expect(await sizeOf(abId)).toBe("1440px×900px");
  const { design } = await ws.resolve(file);
  expect(design.doc.pages[0]!.artboards[0]!.root.style).toMatchObject({
    padding: "24px",
    "min-height": "900px",
    opacity: "1",
  });

  // A style object that sets the size wins over the defaults, and still gets px.
  const styled = await client.callTool({
    name: "create_artboard",
    arguments: { file, name: "Phone", style: { width: "390", height: 844 } },
  });
  expect(text(styled)).toContain("390px×844px");

  const resized = await client.callTool({
    name: "update_artboard",
    arguments: { file, id: abId, width: "1200", height: "800" },
  });
  expect(text(resized)).toContain("1200px×800px");
  await client.callTool({ name: "update_artboard", arguments: { file, id: abId, height: "700" } });
  expect(await sizeOf(abId)).toBe("1200px×700px");

  await client.callTool({
    name: "update_styles",
    arguments: {
      file,
      updates: [{ ids: [abId], style: { width: "1280", height: "fit-content" } }],
    },
  });
  expect(await sizeOf(abId)).toBe("1280px×fit-content");

  const wrote = await client.callTool({
    name: "write_html",
    arguments: {
      file,
      target: abId,
      html: `<div data-name="Box" style="width:320;height:200"></div>`,
    },
  });
  const boxId = /(n_\w+)/.exec(text(wrote))![1]!;
  const node = text(await client.callTool({ name: "get_node", arguments: { file, id: boxId } }));
  expect(node).toContain("width: 320px");
  expect(node).toContain("height: 200px");

  // get_basic_info shows exactly what is stored and written.
  const info = text(await client.callTool({ name: "get_basic_info", arguments: { file } }));
  expect(info).toContain(`${abId} "Desktop" 1280px×fit-content`);
  await design.flush();
  const html = await readFile(join(dir, "sizes.design/pages/home/desktop.html"), "utf8");
  expect(html).toContain("width:1280px;height:fit-content");
  expect(html).toContain("width:320px;height:200px");
});
