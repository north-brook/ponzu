import type { Api } from "@ponzu/client";
import {
  headlineUsd,
  money,
  type Usage,
  usageBar,
  usageLine,
  type WorkspaceKind,
} from "@ponzu/client/model";

/*
 * Usage on the phone: read only (docs/mobile.md, "Settings"). The headline, the line under it
 * and the bar, from the shared billing rules the Mac's Plan and usage draws with. Nothing here
 * changes the cap, adds a card or points anywhere to pay (App Store guideline 3.1.3): the phone's
 * billing words are neutral.
 */

type ApiUsage = Awaited<ReturnType<Api["usage"]["get"]>>;

/**
 * The period as the shared rules take it, as the Mac maps it (studio app/settings/map.ts,
 * `toUsage`): there is no billing yet, so no card, and use past the free credits is not billed.
 */
export function toUsage(usage: ApiUsage): Usage {
  return {
    usedCredits: usage.usedCredits,
    freeCredits: usage.freeCredits,
    creditUsd: usage.creditCents / 100,
    capUsd: usage.cap.usd,
    periodEnd: String(usage.period.end),
    card: null,
    notBilled: usage.billing.status === "not_set_up",
  };
}

/** What the usage block shows: the total, the line under it, and the bar's two shares. */
export interface UsageView {
  headline: string;
  line: string;
  bar: { free: number; billed: number };
}

export function usageView(
  usage: ApiUsage,
  workspace: { kind: WorkspaceKind; name: string },
): UsageView {
  const shared = toUsage(usage);
  const team =
    workspace.kind === "org" ? { name: workspace.name, people: usage.people } : undefined;
  return {
    headline: money(headlineUsd(shared)),
    line: usageLine(shared, team),
    bar: usageBar(shared),
  };
}
