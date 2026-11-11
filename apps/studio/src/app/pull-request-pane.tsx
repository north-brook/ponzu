import { useLiveQuery } from "@ponzu/client/react";
import { useEffect, useMemo } from "react";
import { type PullRequestTabState, PullRequestView } from "../cloud/pr-tab/pull-request-view.tsx";
import { BypassMergeDialog } from "./confirm-dialogs.tsx";
import type { OpenDesign } from "./design.tsx";
import type { Host } from "./host.ts";
import { prSummary, toPullRequestDetail } from "./pull-request-map.ts";
import { useSnapshot } from "./use-snapshot.ts";

/**
 * The pull request tab, in the canvas's pane: what GitHub has, read again as it opens, with
 * the summary from the design's head while the read is on its way or when it fails.
 */
export function PullRequestPane({
  host,
  open,
  viewerLogin,
}: {
  host: Host;
  open: OpenDesign;
  viewerLogin: string;
}) {
  const pull = useSnapshot(open.pullRequest);
  const head = useLiveQuery("design.head", { designId: open.id }).rows?.[0];
  const summary = prSummary(head);
  const store = open.pullRequest;

  // Opening the tab is looking at it now: GitHub's word as of this moment.
  useEffect(() => store.refresh(), [store]);

  const detail = useMemo(
    () => (pull.tab?.pullRequest ? toPullRequestDetail(pull.tab.pullRequest) : null),
    [pull.tab],
  );
  const state: PullRequestTabState | null = detail
    ? { kind: "ready", pr: detail }
    : summary
      ? { kind: pull.status === "error" ? "error" : "loading", summary }
      : null;
  if (!state) return null;
  return (
    <PullRequestView
      state={state}
      viewerLogin={viewerLogin}
      onOpenLink={(url) => host.openExternal(url)}
      onRetry={() => store.refresh()}
      onLoadDiff={store.loadDiff}
    />
  );
}

/** Asks before a merge that goes past the repo's rules, wherever the button was pressed. */
export function BypassConfirmation({ open }: { open: OpenDesign }) {
  const { bypass } = useSnapshot(open.pullRequest);
  return (
    <BypassMergeDialog
      reason={bypass?.reason ?? null}
      onCancel={() => open.pullRequest.cancelBypass()}
      onConfirm={() => open.pullRequest.confirmBypass()}
    />
  );
}
