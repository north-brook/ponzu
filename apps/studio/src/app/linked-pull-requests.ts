import type { CanvasHeadRow, LinkedPullRequest } from "@ponzu/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { PullRequestSummary } from "../cloud/model.ts";
import { usePonzu } from "./ponzu-query.tsx";

/*
 * The pull requests an open canvas links (docs/cloud.md, "Linked pull requests"): read when the
 * canvas's head says it links some, and again whenever how many, or how many are open, moves;
 * linked and unlinked through the client's mutations, which read the list again after.
 */

export interface LinkedPullRequests {
  linked: readonly LinkedPullRequest[];
  /** The first read is on its way. */
  loading: boolean;
  /** Links `url`; answers what to say under the field (a refusal, or that it is already the canvas's), or null once linked. */
  link: (url: string) => Promise<string | null>;
  unlink: (pr: LinkedPullRequest) => void;
}

/** `always`: read even while the head says there are none (the tab, where one can be linked). */
export function useLinkedPullRequests(
  canvasId: string,
  head: Pick<CanvasHeadRow, "prLinkedCount" | "prLinkedOpen"> | undefined,
  { always = false }: { always?: boolean } = {},
): LinkedPullRequests {
  const { queries, mutations } = usePonzu();
  const count = head?.prLinkedCount ?? 0;
  const open = head?.prLinkedOpen ?? 0;
  const query = useQuery({ ...queries.canvasPullRequests(canvasId), enabled: always || count > 0 });
  const linkMutation = useMutation(mutations.linkPullRequests());
  const unlinkMutation = useMutation(mutations.unlinkPullRequest());

  // Read again when the head says a link came, went, merged or closed.
  const moved = `${count}:${open}`;
  const seen = useRef(moved);
  const { refetch } = query;
  useEffect(() => {
    if (seen.current === moved) return;
    seen.current = moved;
    if (always || count > 0) void refetch();
  }, [moved, always, count, refetch]);

  return {
    linked: count > 0 || always ? (query.data?.linked ?? []) : [],
    loading: query.isPending && query.fetchStatus === "fetching",
    link: async (url) => {
      const { results } = await linkMutation.mutateAsync({ canvasId, urls: [url] });
      const [result] = results;
      if (!result || result.result === "linked") return null;
      return result.message;
    },
    unlink: (pr) => unlinkMutation.mutate({ canvasId, repoId: pr.repoId, number: pr.number }),
  };
}

/**
 * The chrome's mark for a canvas with no pull request from its branch, only linked ones: the
 * first linked, and how many more (`linkedCount` is those beyond it). Null until it is read.
 */
export function linkedMark(
  linked: readonly LinkedPullRequest[],
  head: Pick<CanvasHeadRow, "prLinkedCount" | "prLinkedOpen"> | undefined,
): PullRequestSummary | null {
  const first = linked[0];
  if (!first) return null;
  const count = head?.prLinkedCount ?? linked.length;
  return {
    number: first.number,
    state: first.state,
    checks: first.checks,
    mergeable: first.mergeable,
    autoMerge: first.autoMerge,
    linkedCount: Math.max(0, count - 1),
    linkedOpen: head?.prLinkedOpen ?? 0,
  };
}
