import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api } from "@ponzu/client";
import { usageView } from "./usage";

type ApiUsage = Awaited<ReturnType<Api["usage"]["get"]>>;

const usage = (over: Partial<ApiUsage> = {}): ApiUsage =>
  ({
    period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" },
    creditCents: 10,
    usedCredits: 40,
    freeCredits: 100,
    billedCredits: 0,
    billedCents: 0,
    people: 1,
    cap: { usd: 100, isDefault: true, lowestUsd: 1 },
    billing: { status: "not_set_up", card: null, invoices: "not_set_up" },
    canManage: true,
    mine: {
      person: { id: "u", name: "Maya", login: "maya", avatarUrl: null },
      admin: true,
      usedCredits: 40,
    },
    byPerson: null,
    ...over,
  }) as unknown as ApiUsage;

test("within the free credits: what was used, all free, and when it resets", () => {
  const view = usageView(usage(), { kind: "personal", name: "Personal" });
  expect(view.headline).toBe("$4.00");
  expect(view.line).toStartWith("used this month · 40 credits, all free of $10 · resets ");
  expect(view.bar.free).toBeGreaterThan(0);
  expect(view.bar.billed).toBe(0);
});

test("past the free credits before billing exists: past free, not billed yet", () => {
  const view = usageView(usage({ usedCredits: 150, people: 3 } as Partial<ApiUsage>), {
    kind: "org",
    name: "Acme",
  });
  expect(view.headline).toBe("$5.00");
  expect(view.line).toBe("past free this month in Acme · 3 people · 150 credits · not billed yet");
  expect(view.bar.billed).toBeGreaterThan(0);
});

test("the usage block offers nothing to pay, raise or add", () => {
  const source = readFileSync(join(import.meta.dir, "../../components/settings-usage.tsx"), "utf8");
  expect(source).not.toMatch(/Pressable|onPress|Linking|openBrowser|router\./);
  const view = usageView(usage({ usedCredits: 5000 } as Partial<ApiUsage>), {
    kind: "personal",
    name: "Personal",
  });
  for (const words of [view.headline, view.line]) {
    expect(words).not.toMatch(/card|pay|upgrade|raise|cap|add/i);
  }
});
