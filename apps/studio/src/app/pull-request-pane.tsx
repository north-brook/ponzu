import type { PullRequestTab } from "@ponzu/client";
import { useLiveQuery } from "@ponzu/client/react";
import { useEffect, useMemo } from "react";
import {
  LinkedPullRequestsView,
  type PullRequestTabState,
  PullRequestView,
} from "../cloud/pr-tab/pull-request-view.tsx";
import { type OpenCanvas, useAccess } from "./canvas.tsx";
import { BypassMergeDialog, ClosePullRequestDialog } from "./confirm-dialogs.tsx";
import type { Host } from "./host.ts";
import { useLinkedPullRequests } from "./linked-pull-requests.ts";
import { prSummary, toPullRequestDetail } from "./pull-request-map.ts";
import { opensWith, tabMenu } from "./pull-request-store.ts";
import { useSnapshot } from "./use-snapshot.ts";

/**
 * The pull request tab, in the main pane: what GitHub has, read again as it opens, with
 * the summary from the canvas's head while the read is on its way or when it fails.
 */
export function PullRequestPane({
  host,
  open,
  viewerLogin,
}: {
  host: Host;
  open: OpenCanvas;
  viewerLogin: string;
}) {
  const pull = useSnapshot(open.pullRequest);
  const head = useLiveQuery("canvas.head", { canvasId: open.id }).rows?.[0];
  const summary = prSummary(head);
  const store = open.pullRequest;
  // Closing and turning auto-merge off steer the canvas, as the chrome's action does; so do
  // linking and unlinking.
  const canAct = useAccess(open) === "write";
  const links = useLinkedPullRequests(open.id, head, { always: true });
  const linked = {
    linked: links.linked,
    loading: links.loading,
    onLink: canAct ? links.link : null,
    onUnlink: canAct ? links.unlink : null,
  };

  // Opening the tab is looking at it now: GitHub's word as of this moment.
  useEffect(() => store.refresh(), [store]);

  // While it is open and GitHub may still be working (checks to come or under way), it is read
  // again now and then: a check's webhook can be slow, or name a commit the head no longer has.
  const settling = pull.tab?.pullRequest ? stillSettling(pull.tab.pullRequest, Date.now()) : false;
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => store.refresh(), RECHECK_MS);
    return () => clearInterval(timer);
  }, [store, settling]);

  const detail = useMemo(
    () => (pull.tab?.pullRequest ? toPullRequestDetail(pull.tab.pullRequest) : null),
    [pull.tab],
  );
  const state: PullRequestTabState | null = detail
    ? { kind: "ready", pr: detail }
    : summary
      ? { kind: pull.status === "error" ? "error" : "loading", summary }
      : null;
  if (!state) {
    return <LinkedPullRequestsView linked={linked} onOpenLink={(url) => host.openExternal(url)} />;
  }
  return (
    <PullRequestView
      state={state}
      viewerLogin={viewerLogin}
      onOpenLink={(url) => host.openExternal(url)}
      onRetry={() => store.refresh()}
      onLoadDiff={store.loadDiff}
      summary={pull.tab ? opensWith(pull.tab) : null}
      menu={canAct ? tabMenu(pull, store) : null}
      linked={linked}
    />
  );
}

/** How often an open tab reads GitHub again while checks may still be coming. */
const RECHECK_MS = 15_000;

type Pull = NonNullable<PullRequestTab["pullRequest"]>;

/** How long after its last change an open pull request with no checks may still get some. */
const CHECKS_COME_MS = 3 * 60_000;

/**
 * GitHub may still change what the tab shows: a check is queued or running, or an open pull
 * request changed lately and no check has come yet.
 */
export function stillSettling(pr: Pull, now: number): boolean {
  const checks = pr.checks.items;
  if (checks.some((check) => check.state === "pending" || check.state === "running")) return true;
  const open = pr.state === "open" || pr.state === "draft";
  return open && checks.length === 0 && now - Date.parse(pr.updatedAt) < CHECKS_COME_MS;
}

/**
 * Asks before a merge that goes past the repo's rules, wherever the button was pressed, and
 * before closing the pull request from the tab's menu.
 */
export function PullRequestConfirmations({ open }: { open: OpenCanvas }) {
  const { bypass, closing } = useSnapshot(open.pullRequest);
  return (
    <>
      <BypassMergeDialog
        reason={bypass?.reason ?? null}
        onCancel={() => open.pullRequest.cancelBypass()}
        onConfirm={() => open.pullRequest.confirmBypass()}
      />
      <ClosePullRequestDialog
        number={closing?.number ?? null}
        onCancel={() => open.pullRequest.cancelClose()}
        onConfirm={() => open.pullRequest.confirmClose()}
      />
    </>
  );
}
