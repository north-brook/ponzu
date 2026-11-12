import { ApiError } from "@ponzu/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Workspace } from "../../cloud/model.ts";
import { PlanSection } from "../../cloud/settings/plan.tsx";
import { usePonzu } from "../ponzu-query.tsx";
import { toCanvasUsage, toTeamUsage, toUsage } from "./map.ts";
import { SectionUnavailable } from "./unavailable.tsx";

/*
 * Settings › Plan and usage: this billing period's credits, the pooled free ones, the monthly
 * cap (an admin changes it in place), and for an admin who used what and on which canvas.
 *
 * Billing has no card yet (the API answers `not_set_up`): the row says there is none and
 * offers nothing, rather than a button that would go nowhere. While the API's billing switch
 * isn't "on", the section shows credits and that Ponzu is free, with no dollars and no cap.
 */

const REFUSAL_MS = 6000;

export function PlanView({ workspace }: { workspace: Workspace }) {
  const { queries, mutations } = usePonzu();
  const answer = useQuery(queries.usage(workspace.id));
  // Dollars and the cap come back by themselves once the API says billing is on; until `me`
  // answers, and while billing is off or only observed, nothing here is charged.
  const billingOn = useQuery(queries.me()).data?.features.billing === "on";
  const setCap = useMutation(mutations.setCap());
  const refused = setCap.error;
  const { reset } = setCap;
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(reset, REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [refused, reset]);

  if (!answer.data) {
    return answer.isError ? <SectionUnavailable onRetry={() => void answer.refetch()} /> : null;
  }
  const usage = toUsage(answer.data);
  return (
    <>
      <PlanSection
        // While a new cap is on its way, the row shows it.
        usage={setCap.isPending ? { ...usage, capUsd: setCap.variables.capUsd } : usage}
        team={workspace.kind === "org" ? toTeamUsage(answer.data, workspace.name) : null}
        billingOn={billingOn}
        canManage={answer.data.canManage}
        onCapChange={(capUsd) => setCap.mutate({ workspaceId: workspace.id, capUsd })}
        byCanvas={toCanvasUsage(answer.data)}
      />
      {refused ? (
        <p role="alert" className="m-0 text-12 text-danger">
          {refused instanceof ApiError && refused.status !== 0
            ? refused.message
            : "Couldn't reach Ponzu, so the cap didn't change. Try again."}
        </p>
      ) : null}
    </>
  );
}
