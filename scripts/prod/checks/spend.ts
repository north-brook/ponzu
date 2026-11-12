/**
 * Spend alerts live in each vendor's dashboard, where no read-only API reaches them, so the check
 * lists each as `manual`: a person confirms it (docs/production.md, "Spend"). A manual line lets
 * the check pass; it is a reminder, printed every run.
 */
import type { EnvironmentName } from "../desired.ts";
import { type Finding, findings, type Section } from "./finding.ts";

const f = findings("spend");

export const SPEND_LINES = [
  [
    "vercel",
    "Vercel Spend Management: an alert amount, then a pause amount",
    "Vercel › Settings › Billing › Spend Management",
  ],
  ["neon", "the Neon plan's billing alert", "Neon › Billing"],
  ["cloudflare", "Cloudflare billing notifications", "Cloudflare › Notifications › Billing"],
  [
    "anthropic",
    "the Anthropic workspace's monthly spend limit",
    "console.anthropic.com › Workspaces › Limits",
  ],
  ["posthog", "PostHog billing limits for each product", "PostHog › Organization › Billing"],
] as const;

export function evaluateSpend(env: EnvironmentName): Finding[] {
  return SPEND_LINES.map(([id, what, where]) => f.manual(id, `confirm ${what} for ${env}`, where));
}

export const spendSection: Section<EnvironmentName, null> = {
  area: "spend",
  needs: [],
  desired: (ctx) => ctx.env,
  fetchObserved: async () => null,
  evaluate: (env) => evaluateSpend(env),
};
