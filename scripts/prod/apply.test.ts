import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { ApplyArea } from "./apply/area.ts";
import { fakeNetwork, type Routes } from "./apply/testing.ts";
import { AREAS, main, parseArgs } from "./apply.ts";
import type { Io } from "./check.ts";

const TOKEN = "vercel-test-token-0123456789";
const project = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "vercel", "dev-project.json"), "utf8"),
);

function io(
  fetch: typeof globalThis.fetch,
  env: Record<string, string> = {},
): Io & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    print: (l) => lines.push(l),
    env,
    fetch,
    now: () => new Date("2026-11-12T15:00:00Z"),
  };
}

/** ponzu-api-prod after D2, its variables kept as a fake Vercel would keep them. */
function prodVercel(envs: Record<string, unknown>[] = []): Routes {
  return {
    "GET /v9/projects/ponzu-api-prod": () => ({
      ...project,
      name: "ponzu-api-prod",
      id: "prj_prod",
      env: envs,
    }),
    "GET /v10/projects/ponzu-api-prod/env": () => ({ envs }),
    "POST /v10/projects/ponzu-api-prod/env": (s: { body: Record<string, unknown>[] }) => {
      for (const e of s.body)
        envs.push({ ...e, id: `env_${envs.length}`, value: e.type === "plain" ? e.value : "" });
      return { created: [] };
    },
  } as Routes;
}

describe("the command line", () => {
  test("every area the design names, and nothing else", () => {
    expect(AREAS.map((a) => a.name)).toEqual([
      "vercel-project",
      "vercel-env",
      "secrets",
      "firewall",
      "neon",
      "r2",
      "cloudflare-headers",
      "posthog",
      "github-rulesets",
    ]);
  });

  test("an unknown area, a missing --env or stray words are usage errors", async () => {
    expect(parseArgs(["nope", "--env", "dev"])).toBe('no area "nope"');
    expect(parseArgs(["neon"])).toBe("--env must be dev or production");
    expect(parseArgs(["neon", "--env", "staging"])).toBe("--env must be dev or production");
    expect(parseArgs(["neon", "--env", "dev", "now"])).toBe("unexpected now");
    expect(parseArgs(["secrets", "--env", "dev"])).toContain("usage");
    expect(parseArgs(["secrets", "generate", "--names", "DATABASE_URL", "--env", "dev"])).toContain(
      "DATABASE_URL",
    );
    const rulesets = parseArgs(["github-rulesets", "--yes"]);
    expect(typeof rulesets === "object" && rulesets.yes).toBe(true);
    const out = io(fakeNetwork({}).fetch);
    expect(await main(["neon"], out)).toBe(2);
  });

  test("a missing credential reads nothing and exits 1", async () => {
    const net = fakeNetwork({});
    const out = io(net.fetch);
    expect(await main(["firewall", "--env", "dev"], out)).toBe(1);
    expect(out.lines.at(-1)).toBe("skipped (no VERCEL_TOKEN): nothing was read or changed");
    expect(net.seen).toEqual([]);
    expect(await main(["github-rulesets"], out)).toBe(1);
    expect(out.lines.at(-1)).toBe(
      "skipped (no GH_TOKEN, no GITHUB_TOKEN): nothing was read or changed",
    );
  });
});

describe("without --yes", () => {
  test("every area reads only, on dev and on production, and exits 0", async () => {
    // A network that answers every read with 404 and records any write.
    const net = fakeNetwork({});
    const env = {
      VERCEL_TOKEN: TOKEN,
      NEON_API_KEY: "neon-test-key-0123456789",
      NEON_PROJECT_ID: "p",
      CLOUDFLARE_API_TOKEN: "cf-test-token-0123456789",
      CLOUDFLARE_ACCOUNT_ID: "a",
      POSTHOG_PERSONAL_API_KEY: "phx_test_0123456789",
      GH_TOKEN: "ghp_0123456789abcdefghij0123456789",
    };
    for (const area of AREAS) {
      for (const where of ["dev", "production"]) {
        const extra = area.name === "secrets" ? ["generate", "--names", "CRON_SECRET"] : [];
        await main([area.name, ...extra, "--env", where], io(net.fetch, env));
      }
    }
    expect(net.seen.length).toBeGreaterThan(0);
    expect(net.writes()).toEqual([]);
  });

  test("prints each change as its request and body, and says nothing was changed", async () => {
    const net = fakeNetwork(prodVercel());
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN });
    expect(await main(["vercel-env", "--env", "production"], out)).toBe(0);
    expect(out.lines[0]).toBe(
      "Ponzu production: apply vercel-env (dry run: nothing is changed; --yes applies)",
    );
    expect(out.lines).toContain(
      "     POST https://api.vercel.com/v10/projects/ponzu-api-prod/env?slug=northbrook",
    );
    expect(out.lines).toContain('          "key": "PONZU_ENVIRONMENT",');
    expect(out.lines.at(-1)).toBe("1 change; nothing was changed. Run again with --yes to apply.");
    expect(net.writes()).toEqual([]);
  });
});

describe("with --yes", () => {
  test("sends, reads again, and exits 0 only when the area is as infra says", async () => {
    const net = fakeNetwork(prodVercel());
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN });
    expect(await main(["vercel-env", "--env", "production", "--yes"], out)).toBe(0);
    expect(net.writes()).toHaveLength(1);
    expect(out.lines.slice(-3)).toEqual([
      "read again:",
      "ok      vercel.env.public  every public value infra holds is set on the Production target",
      "vercel-env is as infra/ says.",
    ]);
  });

  test("an area still wrong after sending exits 1", async () => {
    const stubborn: ApplyArea = {
      name: "stubborn",
      needs: [],
      async plan() {
        return {
          notes: [],
          changes: [
            {
              says: "x",
              request: { method: "PUT", url: "https://example.test/x", body: {} },
              send: async () => {},
            },
          ],
        };
      },
      async verify() {
        return [{ id: "x.y", area: "x", status: "fail", says: "still wrong" }];
      },
    };
    const out = io(fakeNetwork({}).fetch);
    expect(await main(["stubborn", "--env", "dev", "--yes"], out, [stubborn])).toBe(1);
    expect(out.lines.at(-1)).toBe("stubborn is not yet as infra/ says.");
  });

  test("a failed request stops the rest and exits 1", async () => {
    const sent: number[] = [];
    const area: ApplyArea = {
      name: "two",
      needs: [],
      async plan() {
        const change = (n: number) => ({
          says: `${n}`,
          request: { method: "PUT" as const, url: `https://example.test/${n}`, body: {} },
          send: async () => {
            if (n === 1) throw new Error("Vendor answered 500 for PUT /1");
            sent.push(n);
          },
        });
        return { notes: [], changes: [change(1), change(2)] };
      },
    };
    const out = io(fakeNetwork({}).fetch);
    expect(await main(["two", "--env", "dev", "--yes"], out, [area])).toBe(1);
    expect(sent).toEqual([]);
    expect(out.lines.at(-1)).toBe("stopped after 0 of 2 changes.");
  });
});

describe("secrets generate --yes", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  test("never writes a value to stdout, stderr or disk; it reaches only Vercel, as sensitive", async () => {
    const stdout = spyOn(process.stdout, "write");
    const stderr = spyOn(process.stderr, "write");
    const log = spyOn(console, "log");
    const error = spyOn(console, "error");
    const disk = [
      spyOn(fs, "writeFileSync"),
      spyOn(fs, "appendFileSync"),
      spyOn(fs, "writeFile"),
      spyOn(fs, "createWriteStream"),
      spyOn(fsp, "writeFile"),
      spyOn(fsp, "appendFile"),
      spyOn(Bun, "write"),
    ];
    spies.push(stdout, stderr, log, error, ...disk);

    const envs: Record<string, unknown>[] = [];
    const net = fakeNetwork(prodVercel(envs));
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN });
    const code = await main(
      [
        "secrets",
        "generate",
        "--names",
        "PONZU_VAULT_KEY,CRON_SECRET",
        "--env",
        "production",
        "--yes",
      ],
      out,
    );
    expect(code).toBe(0);
    const values = net
      .writes()
      .flatMap((w) => w.body as { key: string; value: string; type: string; target: string[] }[]);
    expect(values.map((v) => [v.key, v.type, v.target])).toEqual([
      ["PONZU_VAULT_KEY", "sensitive", ["production"]],
      ["CRON_SECRET", "sensitive", ["production"]],
    ]);
    for (const { value } of values) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      for (const line of out.lines) expect(line).not.toContain(value);
    }
    expect(out.lines.slice(-4)).toEqual([
      "read again:",
      "ok      vercel.secrets.PONZU_VAULT_KEY  PONZU_VAULT_KEY is on the Production target, stored as sensitive",
      "ok      vercel.secrets.CRON_SECRET  CRON_SECRET is on the Production target, stored as sensitive",
      "secrets is as infra/ says.",
    ]);
    // Everything went to io.print; nothing to the process's own streams or to any file.
    for (const spy of [stdout, stderr, log, error, ...disk]) expect(spy).not.toHaveBeenCalled();
  });

  test("a vendor error that quotes the value prints it redacted", async () => {
    let quoted = "";
    const net = fakeNetwork({
      ...prodVercel(),
      "POST /v10/projects/ponzu-api-prod/env": (s: { body: { value: string }[] }) => {
        quoted = s.body[0]!.value;
        throw new Error(`refused ${quoted}`);
      },
    });
    const out = io(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          return await net.fetch(input, init);
        } catch (e) {
          return new Response(JSON.stringify({ error: { message: (e as Error).message } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
      }) as typeof fetch,
      { VERCEL_TOKEN: TOKEN },
    );
    expect(
      await main(
        ["secrets", "generate", "--names", "CRON_SECRET", "--env", "production", "--yes"],
        out,
      ),
    ).toBe(1);
    expect(quoted).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out.lines.join("\n")).not.toContain(quoted);
    expect(out.lines.join("\n")).not.toContain(TOKEN);
  });
});
