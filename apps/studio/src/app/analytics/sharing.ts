import { useEffect } from "react";
import type { Host } from "../host.ts";
import type { Analytics } from "./analytics.ts";
import { useAnalytics } from "./provider.tsx";

/*
 * Settings › Account › Share usage data, followed in this window (docs/analytics.md, "Turning it
 * off"). The switch is the account's (`me.privacy.shareUsage`), so turning it off on one device
 * reaches every other through the live `me` row.
 *
 * Off, from anywhere: this window's PostHog stops at once (its opt-out is kept in its own
 * storage, so it holds at the next launch), and, if this window was reporting, the shell is told
 * too: it writes ~/.ponzu/telemetry.json, so the next launch loads nothing, and stops its own
 * error reporting.
 *
 * On, from another device: this window's PostHog starts again if it was loaded. The shell's
 * file is written on only by the toggle on this computer, so a `ponzu telemetry off` from 1.x,
 * or an earlier "off" here, is never undone from elsewhere.
 */
export function followUsageSharing(
  analytics: Analytics,
  host: Pick<Host, "setUsageSharing">,
  shareUsage: boolean,
): void {
  analytics.setSharing(shareUsage);
  if (!shareUsage && analytics.reporting) void host.setUsageSharing?.(false).catch(() => {});
}

/** `followUsageSharing` whenever the account's switch is known or changes. */
export function useUsageSharing(host: Host, shareUsage: boolean | undefined): void {
  const analytics = useAnalytics();
  useEffect(() => {
    if (shareUsage !== undefined) followUsageSharing(analytics, host, shareUsage);
  }, [analytics, host, shareUsage]);
}

/**
 * The toggle on this computer: this window's PostHog at once, then the shell's file. Answers
 * whether recording starts only at the next launch (turned on in a window that loaded nothing
 * to report with, on a build and computer that will report).
 */
export async function setUsageSharingHere(
  analytics: Analytics,
  host: Pick<Host, "setUsageSharing">,
  on: boolean,
): Promise<boolean> {
  analytics.setSharing(on);
  const nextLaunchReports = (await host.setUsageSharing?.(on).catch(() => false)) ?? false;
  return on && nextLaunchReports && !analytics.reporting;
}
