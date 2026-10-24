import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestDoc, parseJournal } from "@ponzu/core";
import { ignoresJournal, readJournal } from "./journal.ts";
import { LocalWorkspace } from "./workspace.ts";

const agent = { kind: "agent" as const, name: "Claude" };

async function tmpDesign() {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-journal-"));
  return join(dir, "fern.design");
}

describe("journal", () => {
  test("starts with a checkpoint, appends each op with time and origin, and ignores itself", async () => {
    const path = await tmpDesign();
    const ws = new LocalWorkspace({ previews: false });
    const { key, design } = await ws.open(path);
    design.apply({ op: "page.create", index: 0, page: { id: "pg", name: "Home" } }, agent);
    design.apply({ op: "file.rename", name: "Fernwood" }, { kind: "user", name: "Bryce" });
    await ws.journalFlushed(key);
    const entries = await readJournal(key);
    expect(entries.map((e) => e.kind)).toEqual(["checkpoint", "op", "op"]);
    const op = entries[1]!;
    expect(op.kind === "op" && op.origin).toEqual(agent);
    expect(Math.abs(op.t - Date.now())).toBeLessThan(5000);
    expect(latestDoc(entries)!.name).toBe("Fernwood");
    expect(await readFile(join(key, ".ponzu/.gitignore"), "utf8")).toBe("*\n");
    await ws.closeAll();

    // Reopened unchanged: no second checkpoint.
    const again = new LocalWorkspace({ previews: false });
    await again.open(path);
    await again.journalFlushed(path);
    expect((await readJournal(path)).filter((e) => e.kind === "checkpoint")).toHaveLength(1);
    await again.closeAll();
  });

  test("a journal that doesn't match the folder gets a fresh checkpoint", async () => {
    const path = await tmpDesign();
    const ws = new LocalWorkspace({ previews: false });
    const { key, design } = await ws.open(path);
    design.apply({ op: "file.rename", name: "One" }, agent);
    await ws.closeAll();
    const text = await readFile(join(key, ".ponzu/journal.ndjson"), "utf8");
    // Drop the rename from the journal: replay no longer matches design.json.
    await writeFile(join(key, ".ponzu/journal.ndjson"), `${text.split("\n")[0]}\n`);
    const again = new LocalWorkspace({ previews: false });
    await again.open(path);
    await again.journalFlushed(path);
    const entries = parseJournal(await readFile(join(key, ".ponzu/journal.ndjson"), "utf8"));
    expect(entries.filter((e) => e.kind === "checkpoint")).toHaveLength(2);
    expect(latestDoc(entries)!.name).toBe("One");
    await again.closeAll();
  });

  test("keeps the journal ignored when .ponzu/.gitignore keeps the previews", () => {
    expect(ignoresJournal("*\n")).toBe(true);
    expect(ignoresJournal("*\n!preview.png\n!preview-dark.png\n")).toBe(true);
    expect(ignoresJournal("version\n")).toBe(false);
    expect(ignoresJournal("*\n!journal.ndjson\n")).toBe(false);
  });
});
