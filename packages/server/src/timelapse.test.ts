import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "./serve.ts";
import { timelapsePath } from "./timelapse.ts";
import { LocalWorkspace } from "./workspace.ts";

describe("timelapse", () => {
  test("films are dated, and numbered on collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "ponzu-tl-"));
    const day = new Date(2026, 9, 22);
    expect(timelapsePath(root, "mp4", day)).toBe(join(root, "exports/timelapse-2026-10-22.mp4"));
    await mkdir(join(root, "exports"));
    await writeFile(join(root, "exports/timelapse-2026-10-22.mp4"), "");
    await writeFile(join(root, "exports/timelapse-2026-10-22-2.mp4"), "");
    expect(timelapsePath(root, "mp4", day)).toBe(join(root, "exports/timelapse-2026-10-22-3.mp4"));
  });

  test("the studio's API reads the journal and says what a film can cover", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ponzu-tl-"));
    const ws = new LocalWorkspace({ previews: false });
    const { key, design } = await ws.open(join(dir, "fern.design"));
    design.apply({ op: "file.rename", name: "Fern" }, { kind: "agent", name: "Claude" });
    const server = serve(ws, { port: 0, spotlight: false, dbFile: ":memory:" });
    try {
      const base = `http://127.0.0.1:${server.port}/api/timelapse`;
      const q = `?file=${encodeURIComponent(key)}`;
      const journal = await (await fetch(`${base}/journal${q}`)).text();
      expect(journal.split("\n").filter(Boolean)).toHaveLength(2);
      const info = (await (await fetch(`${base}/info${q}`)).json()) as Record<string, unknown>;
      expect(info.renderer).toBe(false);
      expect(info.comments).toEqual([]);
      const start = await fetch(`${base}${q}`, { method: "POST", body: "{}" });
      expect(start.status).toBe(409);
      expect(((await start.json()) as { error: string }).error).toContain("renderer");
      expect(existsSync(join(key, ".ponzu/journal.ndjson"))).toBe(true);

      // Past films: what's in exports/, newest first, and only those by name.
      expect(await (await fetch(`${base}/films${q}`)).json()).toEqual([]);
      await mkdir(join(key, "exports"), { recursive: true });
      await writeFile(join(key, "exports/timelapse-2026-10-21.mp4"), "old");
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(join(key, "exports/timelapse-2026-10-22.mp4"), "new");
      await writeFile(join(key, "exports/board.png"), "not a film");
      const films = (await (await fetch(`${base}/films${q}`)).json()) as { name: string }[];
      expect(films.map((f) => f.name)).toEqual([
        "timelapse-2026-10-22.mp4",
        "timelapse-2026-10-21.mp4",
      ]);
      const one = await fetch(`${base}/film${q}&name=timelapse-2026-10-21.mp4`);
      expect(await one.text()).toBe("old");
      expect((await fetch(`${base}/film${q}&name=board.png`)).status).toBe(404);
      expect((await fetch(`${base}/film${q}&name=..%2Fdesign.json`)).status).toBe(404);

      // Another site's page can't start or cancel a film (a no-cors POST needs no preflight).
      const cross = await fetch(`${base}${q}`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "text/plain" },
        body: "{}",
      });
      expect(cross.status).toBe(403);
      const cancel = await fetch(`${base}/cancel?id=tl_1`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      });
      expect(cancel.status).toBe(403);
    } finally {
      server.stop(true);
      await ws.closeAll();
    }
  });
});
