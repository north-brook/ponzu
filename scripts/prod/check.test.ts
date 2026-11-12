import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  exitCode,
  formatFinding,
  type Io,
  main,
  readCredentials,
  runSection,
  SECTIONS,
  summary,
} from "./check.ts";
import {
  type AnySection,
  type CheckContext,
  describeError,
  type Finding,
  type Status,
} from "./checks/finding.ts";
import { loadInfra } from "./desired.ts";

const line = (status: Status, id = "x.y"): Finding => ({ id, area: "x", status, says: "says" });

const TOKEN = "vercel-token-0123456789abcdef";
const CRON = "cron-secret-0123456789abcdef";

/** A section that reads by calling `read`, and says what it was given. */
function section(
  overrides: Partial<AnySection> & { read?: () => Promise<unknown> },
): AnySection & { reads: number } {
  const s = {
    area: "fake",
    needs: [],
    reads: 0,
    desired: () => "wanted",
    async fetchObserved() {
      s.reads++;
      return overrides.read ? overrides.read() : "seen";
    },
    evaluate: (d: unknown, o: unknown) => [
      { id: "fake.thing", area: "fake", status: "ok" as Status, says: `${d} ${o}` },
    ],
    ...overrides,
  };
  return s;
}

function io(env: Record<string, string> = {}): Io & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    print: (l) => lines.push(l),
    env,
    fetch: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    now: () => new Date("2026-11-12T12:00:00Z"),
  };
}

const ctx = (credentials = {}, deep = false): CheckContext => ({
  env: "dev",
  infra: loadInfra(),
  credentials,
  fetch: globalThis.fetch,
  now: () => new Date(),
  deep,
});

describe("exit code", () => {
  test("0 only when every line is ok or manual", () => {
    expect(exitCode([line("ok"), line("manual")])).toBe(0);
    for (const status of ["fail", "pending", "skipped"] as const) {
      expect(exitCode([line("ok"), line(status)])).toBe(1);
    }
    expect(exitCode([])).toBe(1);
  });
});

describe("runSection", () => {
  test("a missing credential skips the section, naming it, and reads nothing", async () => {
    const s = section({ needs: ["VERCEL_TOKEN", "VERCEL_TEAM_ID"] });
    const findings = await runSection(s, ctx({ VERCEL_TOKEN: TOKEN }));
    expect(findings).toEqual([
      {
        id: "fake.credentials",
        area: "fake",
        status: "skipped",
        says: "skipped (no VERCEL_TEAM_ID)",
        fix: "set VERCEL_TEAM_ID in the environment (docs/production.md › Checking production)",
      },
    ]);
    expect(s.reads).toBe(0);
  });

  test("with its credentials it reads, then judges what it read", async () => {
    const s = section({ needs: ["VERCEL_TOKEN"] });
    expect(await runSection(s, ctx({ VERCEL_TOKEN: TOKEN }))).toEqual([
      { id: "fake.thing", area: "fake", status: "ok", says: "wanted seen" },
    ]);
  });

  test("a read that throws is a failing line, not a crash", async () => {
    const s = section({ read: async () => Promise.reject(new Error("503: upstream down\nbody…")) });
    expect(await runSection(s, ctx())).toEqual([
      {
        id: "fake.read",
        area: "fake",
        status: "fail",
        says: "could not be read: 503: upstream down",
      },
    ]);
  });

  test("a deep-only section runs only with --deep", async () => {
    const s = section({ deepOnly: true });
    expect(await runSection(s, ctx())).toEqual([]);
    expect(s.reads).toBe(0);
    expect(await runSection(s, ctx({}, true))).toHaveLength(1);
  });
});

describe("main", () => {
  test("refuses a missing or unknown environment, or an unknown flag", async () => {
    for (const argv of [[], ["--env", "staging"], ["--env", "dev", "--yes"]]) {
      const out = io();
      expect(await main(argv, out, [])).toBe(2);
      expect(out.lines).toEqual([
        "usage: bun scripts/prod/check.ts --env <dev|production> [--json] [--deep]",
      ]);
    }
  });

  test("prints every line, the fix under it, and a summary; skipped exits 1", async () => {
    const out = io();
    const code = await main(["--env", "dev"], out, [
      section({
        evaluate: () => [line("ok", "fake.a"), { ...line("fail", "fake.b"), fix: "do this" }],
      }),
      section({ area: "other", needs: ["CRON_SECRET"] }),
    ]);
    expect(code).toBe(1);
    expect(out.lines).toEqual([
      "Ponzu dev: check of every resource against infra/",
      "ok      fake.a  says",
      "fail    fake.b  says",
      "        ↳ do this",
      "skipped other.credentials  skipped (no CRON_SECRET)",
      "        ↳ set CRON_SECRET in the environment (docs/production.md › Checking production)",
      "1 ok, 1 fail, 1 skipped",
    ]);
  });

  test("no line ever carries a credential, even when a vendor's error quotes one", async () => {
    const out = io({ VERCEL_TOKEN: TOKEN, CRON_SECRET: CRON });
    await main(["--env", "dev"], out, [
      section({
        read: async () => Promise.reject(new Error(`refused token ${TOKEN} and ${CRON}`)),
      }),
      section({
        area: "says",
        evaluate: () => [{ ...line("fail"), says: `got ${CRON}`, fix: `use ${TOKEN}` }],
      }),
    ]);
    const text = out.lines.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(CRON);
    expect(text).toContain("[redacted]");
  });

  test("--json prints one redacted document with the exit code", async () => {
    const out = io({ CRON_SECRET: CRON });
    const code = await main(["--env", "production", "--json"], out, [
      section({ evaluate: () => [{ ...line("ok"), says: `holds ${CRON}` }] }),
    ]);
    expect(code).toBe(0);
    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0] as string)).toEqual({
      env: "production",
      findings: [{ id: "x.y", area: "x", status: "ok", says: "holds [redacted]" }],
      exitCode: 0,
    });
  });

  test("--json redacts a secret that JSON would escape", async () => {
    const quoted = 'cron"secret\\0123456789abcdef';
    const out = io({ CRON_SECRET: quoted });
    await main(["--env", "dev", "--json"], out, [
      section({ evaluate: () => [{ ...line("fail"), says: `holds ${quoted}`, fix: quoted }] }),
    ]);
    const text = out.lines.join("\n");
    expect(text).not.toContain(JSON.stringify(quoted).slice(1, -1));
    expect(JSON.parse(text).findings[0]).toMatchObject({
      says: "holds [redacted]",
      fix: "[redacted]",
    });
  });
});

describe("pieces", () => {
  test("credentials are read by name, trimmed, and empty ones are missing", () => {
    expect(readCredentials({ VERCEL_TOKEN: ` ${TOKEN} `, CRON_SECRET: "", OTHER: "x" })).toEqual({
      VERCEL_TOKEN: TOKEN,
    });
  });

  test("an answer in an unknown shape says where, not a line of JSON", () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 1 });
    expect(describeError(parsed.error)).toBe(
      "answered in a shape the check does not know (name: Invalid input: expected string, received number)",
    );
  });

  test("an ok line prints no fix", () => {
    expect(formatFinding({ ...line("ok"), fix: "never shown" })).toEqual(["ok      x.y  says"]);
  });

  test("the summary counts each status in a fixed order", () => {
    expect(summary([line("skipped"), line("ok"), line("ok"), line("manual")])).toBe(
      "2 ok, 1 manual, 1 skipped",
    );
  });

  test("the sections, in the order they print", () => {
    expect(SECTIONS.map((s) => s.area)).toEqual([
      "vercel",
      "neon",
      "cloudflare",
      "api",
      "dns",
      "spend",
      "deep",
    ]);
    expect(SECTIONS.find((s) => s.area === "vercel")?.needs).toEqual(["VERCEL_TOKEN"]);
    expect(SECTIONS.find((s) => s.area === "neon")?.needs).toEqual([
      "NEON_API_KEY",
      "NEON_PROJECT_ID",
    ]);
    expect(SECTIONS.find((s) => s.area === "cloudflare")?.needs).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
    ]);
    expect(SECTIONS.find((s) => s.area === "deep")?.deepOnly).toBe(true);
  });
});
