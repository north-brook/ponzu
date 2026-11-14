import { ApiError } from "@ponzu/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Workspace } from "../../cloud/model.ts";
import { PlanSection } from "../../cloud/settings/plan.tsx";
import { useAnalytics } from "../analytics/provider.tsx";
import { useBillingWall } from "../billing/wall.tsx";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { toCanvasUsage, toTeamUsage, toUsage } from "./map.ts";
import { SectionUnavailable } from "./unavailable.tsx";

/*
 * Settings › Plan and usage: this billing period's credits, the pooled free ones, the monthly
 * cap (an admin changes it in place), and for an admin who used what and on which canvas.
 *
 * While the API's billing switch isn't "on" (off, or only observing), the section shows credits
 * and that Ponzu is free, with no dollars and no cap, and the Card row says there is none and
 * offers nothing: exactly as Ponzu 2.1 did. Once it is on, an admin adds a card (Stripe's
 * Checkout page, through the billing wall's Add a card dialog), opens Stripe's portal to change
 * it, and pays an invoice that is past due.
 */

const REFUSAL_MS = 6000;

export function PlanView({ workspace, host }: { workspace: Workspace; host?: Host }) {
  const { queries, mutations } = usePonzu();
  const answer = useQuery(queries.usage(workspace.id));
  // Dollars and the cap come back by themselves once the API says billing is on; until `me`
  // answers, and while billing is off or only observed, nothing here is charged.
  const billingOn = useQuery(queries.me()).data?.features.billing === "on";
  const wall = useBillingWall();
  const analytics = useAnalytics();
  const setCap = useMutation(mutations.setCap());
  const portal = useMutation(mutations.openBillingPortal());
  const refused = setCap.error ?? portal.error;
  const reset = setCap.error ? setCap.reset : portal.reset;
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(reset, REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [refused, reset]);

  if (!answer.data) {
    return answer.isError ? <SectionUnavailable onRetry={() => void answer.refetch()} /> : null;
  }
  const data = answer.data;
  const usage = toUsage(data);
  // Cards, the portal and invoices only while Ponzu bills, and only where they can go somewhere.
  const manage = billingOn && data.canManage && host !== undefined;
  const invoiceUrl = usage.pastDue?.invoiceUrl ?? null;
  return (
    <>
      <PlanSection
        // While a new cap is on its way, the row shows it.
        usage={setCap.isPending ? { ...usage, capUsd: setCap.variables.capUsd } : usage}
        team={workspace.kind === "org" ? toTeamUsage(data, workspace.name) : null}
        billingOn={billingOn}
        canManage={data.canManage}
        onCapChange={(capUsd) => setCap.mutate({ workspaceId: workspace.id, capUsd })}
        {...(manage && wall && !usage.card
          ? {
              onAddCard: () =>
                wall.addCard({
                  workspaceId: workspace.id,
                  workspaceName: workspace.name,
                  canManage: true,
                  capUsd: data.cap.usd,
                  billedCents: data.billedCents,
                  periodEnd: String(data.period.end),
                  invoiceUrl: null,
                }),
            }
          : {})}
        {...(manage && usage.card
          ? {
              onManageCard: () =>
                portal.mutate(workspace.id, {
                  onSuccess: ({ url }) => {
                    analytics.capture("billing portal opened");
                    host.openExternal(url);
                  },
                }),
            }
          : {})}
        {...(manage && invoiceUrl ? { onPayInvoice: () => host.openExternal(invoiceUrl) } : {})}
        byCanvas={toCanvasUsage(data)}
      />
      {refused ? (
        <p role="alert" className="m-0 text-12 text-danger">
          {refused instanceof ApiError && refused.status !== 0
            ? refused.message
            : refused === portal.error
              ? "Couldn't reach Ponzu. Try again."
              : "Couldn't reach Ponzu, so the cap didn't change. Try again."}
        </p>
      ) : null}
    </>
  );
}
