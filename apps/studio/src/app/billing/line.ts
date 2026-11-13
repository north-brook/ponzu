import { billingBlocker, blockerWords } from "@ponzu/client/model/gate";
import { useQuery } from "@tanstack/react-query";
import type { BillingWait } from "../../cloud/thread/lines.tsx";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { useBillingWall } from "./wall.tsx";

/*
 * A canvas waiting on its workspace's billing, as its thread's foot says it (the billing plan,
 * §8.3): the head's blocker in the Mac's words, with the button that lifts it for someone who
 * can manage billing. "Add a card" opens Add a card, and once it is added the API resumes the
 * canvas by itself; "Raise cap" opens the cap dialog with nothing held; "Pay invoice" opens
 * Stripe's page for it. Members read the line with no button.
 *
 * Only while the API bills: with billing off or observing, no canvas carries these blockers,
 * and this reads nothing (not even the workspace's usage).
 */

/** The window's workspace as the line names it, and whether the viewer may manage its billing. */
export interface BillingWorkspace {
  id: string;
  name: string;
  personal: boolean;
  canManage: boolean;
}

export function useBillingLine(
  host: Host,
  workspace: BillingWorkspace | null,
  blocker: string | null | undefined,
): BillingWait | null {
  const { queries } = usePonzu();
  const wall = useBillingWall();
  // The window's own `me`, as it already has it: this asks for nothing.
  const on = useQuery({ ...queries.me(), enabled: false }).data?.features.billing === "on";
  const billing =
    on &&
    workspace !== null &&
    (blocker === "credits_used_up" || blocker === "cap_reached" || blocker === "payment_failed");
  const usage = useQuery({ ...queries.usage(workspace?.id ?? ""), enabled: billing });
  if (!billing || !workspace) return null;
  const read = usage.data
    ? { capUsd: usage.data.cap.usd, periodEnd: String(usage.data.period.end) }
    : null;
  const gate = billingBlocker(blocker, {
    workspace: { name: workspace.name, personal: workspace.personal },
    canManage: workspace.canManage,
    usage: read,
  });
  if (!gate) return null;
  const words = blockerWords(gate);
  const data = usage.data;
  const details = data
    ? {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        canManage: workspace.canManage,
        capUsd: data.cap.usd,
        billedCents: data.billedCents,
        periodEnd: String(data.period.end),
        invoiceUrl: data.billing.pastDue?.invoiceUrl ?? null,
      }
    : null;
  const onAction = (() => {
    if (!words.action || !details || !wall) return undefined;
    switch (gate.blocker) {
      case "credits_used_up":
        return () => wall.addCard(details);
      case "cap_reached":
        return () => wall.open({ ...details, reason: "cap_reached" });
      case "payment_failed": {
        const url = details.invoiceUrl;
        return url ? () => host.openExternal(url) : undefined;
      }
    }
  })();
  return { text: words.line, action: words.action, ...(onAction ? { onAction } : {}) };
}
