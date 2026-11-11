import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { TGZ_MTIME, tgz } from "../scripts/tgz.ts";

const files = () => [
  { name: "runner.js", bytes: new TextEncoder().encode("console.log('runner');\n") },
  { name: "manifest.json", bytes: new TextEncoder().encode('{"name":"ponzu-runner"}\n') },
  { name: "supervise.js", bytes: new Uint8Array(1024).fill(7) },
];

test("the same files make the same bytes, in whatever order they come", () => {
  const a = tgz(files());
  const b = tgz(files().reverse());
  expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  // gzip: no time in the header, and Unix as the OS wherever it was packed.
  expect([...a.slice(4, 8)]).toEqual([0, 0, 0, 0]);
  expect(a[9]).toBe(3);
});

test("a different file makes a different archive", () => {
  const other = files();
  other[0]!.bytes = new TextEncoder().encode("console.log('another');\n");
  expect(Buffer.compare(Buffer.from(tgz(files())), Buffer.from(tgz(other)))).not.toBe(0);
});

test("tar reads it back: sorted plain files, root's, 0644, at the fixed time", () => {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-tgz-"));
  try {
    const file = join(dir, "b.tgz");
    writeFileSync(file, tgz(files()));
    const listed = spawnSync("tar", ["-tzf", file], { encoding: "utf8" });
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim().split("\n")).toEqual([
      "manifest.json",
      "runner.js",
      "supervise.js",
    ]);
    const out = join(dir, "out");
    mkdirSync(out);
    expect(spawnSync("tar", ["-xzf", file, "-C", out]).status).toBe(0);
    expect(readFileSync(join(out, "supervise.js"))).toEqual(Buffer.from(files()[2]!.bytes));
    const tar = gunzipSync(readFileSync(file));
    expect(tar.length % 512).toBe(0);
    const mtime = Number.parseInt(tar.subarray(136, 147).toString(), 8);
    expect(mtime).toBe(TGZ_MTIME);
    expect(tar.subarray(100, 107).toString()).toBe("0000644");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name that is not a plain file name, or one twice, is refused", () => {
  const bytes = new Uint8Array(1);
  expect(() => tgz([{ name: "../x", bytes }])).toThrow();
  expect(() => tgz([{ name: "a/b", bytes }])).toThrow();
  expect(() =>
    tgz([
      { name: "a", bytes },
      { name: "a", bytes },
    ]),
  ).toThrow();
});
