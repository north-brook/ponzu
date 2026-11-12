import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FirewallSchema } from "../../../../scripts/prod/desired.ts";
import { RATE_LIMIT_IDS, RATE_LIMITS, type RateLimitId } from "./rate-limits.ts";

/*
 * The per-caller limits are counted by Vercel's firewall, and each id the code names is a rule in
 * infra/vercel-firewall.json whose one condition is that `@vercel/firewall` rate-limit id. The code
 * says which id a request counts against; the rule says how many it may make. These tests hold the
 * two to each other: an id the JSON lacks would fail open in production (the SDK answers
 * `not-found`, logged as `rate_limit_unavailable`), and a rule the code never names is dead config.
 *
 * The rule's shape is pinned in deps/fixtures/firewall-rate-limit-rule.json. It follows
 * @vercel/sdk's firewall config types (the `rate_limit_api_id` condition type); it has not yet
 * been compared with a rule made in the dashboard (`vercel firewall rules inspect --json`). When
 * it is, the fixture is replaced with what that prints and these tests say what else must change.
 */

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const firewall = FirewallSchema.parse(read("infra/vercel-firewall.json"));
const fixture = read("apps/api/src/deps/fixtures/firewall-rate-limit-rule.json");

type Rule = (typeof firewall.rules)[number];

/** The rate-limit ids a rule names in its conditions. */
const idsOf = (rule: Rule) =>
  rule.conditionGroup.flatMap((group) =>
    group.conditions
      .filter((condition) => condition.type === "rate_limit_api_id")
      .map((condition) => String(condition.value)),
  );

const sdkRules = firewall.rules.filter((rule) => idsOf(rule).length > 0);

describe("the firewall's per-caller rules and the code's ids", () => {
  test("every id the code names has exactly one rule, and every rule names an id the code has", () => {
    const named = sdkRules.flatMap(idsOf);
    expect([...named].sort()).toEqual([...RATE_LIMIT_IDS].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  test("each rule's window and limit are the table's, counted in fixed windows as the fake counts", () => {
    const inJson = Object.fromEntries(
      sdkRules.map((rule) => {
        const limit = rule.action.mitigate.rateLimit!;
        return [idsOf(rule)[0], `${limit.limit}/${limit.window}s ${limit.algo}`];
      }),
    );
    const inCode = Object.fromEntries(
      RATE_LIMIT_IDS.map((id) => {
        const { limit, windowSeconds } = RATE_LIMITS[id];
        return [id, `${limit}/${windowSeconds}s fixed_window`];
      }),
    );
    expect(inJson).toEqual(inCode);
  });

  test("each rule has the pinned shape: on, one condition naming its id, and a rate_limit action", () => {
    for (const rule of sdkRules) {
      const id = idsOf(rule)[0] as RateLimitId;
      const { limit, windowSeconds } = RATE_LIMITS[id];
      expect(rule).toEqual({
        ...fixture,
        name: rule.name,
        description: rule.description,
        conditionGroup: [
          { conditions: [{ ...fixture.conditionGroup[0].conditions[0], value: id }] },
        ],
        action: {
          mitigate: {
            ...fixture.action.mitigate,
            rateLimit: { ...fixture.action.mitigate.rateLimit, window: windowSeconds, limit },
          },
        },
      });
    }
  });

  test("each rule says its id and numbers in words, and is named for its id", () => {
    for (const rule of sdkRules) {
      const id = idsOf(rule)[0] as RateLimitId;
      const { key, limit, windowSeconds } = RATE_LIMITS[id];
      const per = windowSeconds === 60 ? "a minute" : "an hour";
      const whose = key === "user" ? "person" : "canvas";
      expect(rule.name).toBe(`${id} per caller`);
      expect(rule.description).toBe(
        `@vercel/firewall rate-limit id ${id}: ${limit.toLocaleString("en-US")} ${per} per ${whose}, keyed in code.`,
      );
    }
  });

  test("an id goes into the SDK's URL as it is, so the rule and the request name the same thing", () => {
    for (const id of RATE_LIMIT_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
      expect(encodeURIComponent(id)).toBe(id);
    }
  });

  test("the runner's model report has no firewall rule: the runner protocol throttles it", () => {
    expect(sdkRules.flatMap(idsOf)).not.toContain("runner-models");
  });

  test("the per-address rules sit beside the per-caller ones, and none of them names an id", () => {
    const perIp = firewall.rules.filter((rule) => idsOf(rule).length === 0);
    expect(perIp.map((rule) => rule.name)).toEqual([
      "cron needs a bearer",
      "sign-in exchange per ip",
      "github setup per ip",
      "claude sign-ins per ip",
      "api per ip",
    ]);
  });
});
