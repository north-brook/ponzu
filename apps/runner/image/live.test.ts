import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesWithSecrets, secretsIn, secretValues } from "./live.ts";

const dir = mkdtempSync(join(tmpdir(), "ponzu-live-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Made up for the test: none is a real credential.
const vault = "vault-0123456789abcdef";
const key = "made-up-app-key\nsecond-line";
writeFileSync(join(dir, "app.pem"), `${key}\n`);
const env = {
  PONZU_VAULT_KEY: vault,
  CRON_SECRET: "cron-secret-made-up-1",
  GITHUB_APP_PRIVATE_KEY_PATH: join(dir, "app.pem"),
  GITHUB_TEST_REPO: "north-brook/ponzu-test-repo-long-name",
  SHORT_TOKEN: "abc",
};

test("a secret is any variable named like one, long enough, and a key file by its contents", () => {
  const secrets = secretValues(env);
  expect([...secrets.keys()].sort()).toEqual([
    "CRON_SECRET",
    "GITHUB_APP_PRIVATE_KEY_PATH",
    "PONZU_VAULT_KEY",
  ]);
  expect(secrets.get("GITHUB_APP_PRIVATE_KEY_PATH")).toBe(key);
});

test("a command holding a secret's value or a key's shape is caught; the scan's own patterns are not", () => {
  const secrets = secretValues(env);
  expect(secretsIn(`echo ${vault} > /tmp/x`, secrets)).toEqual(["PONZU_VAULT_KEY"]);
  expect(secretsIn(`curl -H 'x: sk-ant-api03-${"a".repeat(20)}'`, secrets)).toEqual([
    "a key's shape",
  ]);
  expect(secretsIn("grep -e 'sk-ant-[a-z]{3,5}[0-9]{2}-[A-Za-z0-9_-]{80,}' /", secrets)).toEqual(
    [],
  );
  expect(secretsIn("grep -e 'pzr_[A-Za-z0-9_-]{20,}' /", secrets)).toEqual([]);
  expect(secretsIn("/opt/ponzu/bin/ponzu-stop", secrets)).toEqual([]);
});

test("a staged file holding a secret's value is found, by name only", () => {
  const staged = join(dir, "staged");
  mkdirSync(join(staged, "libexec"), { recursive: true });
  writeFileSync(join(staged, "libexec", "ponzu-start"), `token=${vault}`);
  writeFileSync(join(staged, "provision.sh"), "echo hello");
  expect(filesWithSecrets(staged, secretValues(env))).toEqual([
    `${join(staged, "libexec", "ponzu-start")} (PONZU_VAULT_KEY)`,
  ]);
});
