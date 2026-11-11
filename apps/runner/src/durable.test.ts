import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDurably } from "./durable.ts";

const dir = mkdtempSync(join(tmpdir(), "ponzu-durable-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("writes the whole file in place of the old one, readable by its owner only", () => {
  const path = join(dir, "state", "usage.json");
  writeDurably(path, '{"a":1}');
  writeDurably(path, new TextEncoder().encode('{"a":2}'));
  expect(readFileSync(path, "utf8")).toBe('{"a":2}');
  expect(existsSync(`${path}.next`)).toBe(false);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
