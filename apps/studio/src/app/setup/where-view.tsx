import type { DeepLink } from "@ponzu/desktop/bridge";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GithubAccount } from "../../cloud/setup/setup.ts";
import { type InstallNotice, WhereStep } from "../../cloud/setup/where.tsx";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";

/*
 * "Where do you build?", live: the person's GitHub accounts, Set up opening GitHub's install
 * page in the browser, and on coming back (the install's outcome, by the setup page's link or by
 * asking the API, or the window coming to the front) a sync with GitHub, which turns the row
 * Ready. Continue records the
 * step, and the gates move on.
 *
 * The list comes from the sync guided setup runs as the step opens (`useArrivalSync`), and is
 * shown only once that has answered: one call to GitHub for it, not a read and then a sync.
 */

/** Coming back to the window asks GitHub again, but not more often than this. */
const FOCUS_SYNC_MS = 2_000;

/**
 * Asks GitHub once as the step opens, since what the last sign-in's sync saw may be old, and
 * answers whether the list is still on its way. If the sync fails, the accounts are read
 * instead, and if that fails too the step says so.
 */
export function useArrivalSync(onStep: boolean): { loading: boolean } {
  const { queries, mutations } = usePonzu();
  const sync = useMutation(mutations.syncGithub());
  const asked = useRef(false);
  const syncNow = sync.mutate;
  useEffect(() => {
    // Back on the step later (GitHub took the only workspace away): GitHub is asked again.
    if (!onStep) asked.current = false;
    if (!onStep || asked.current) return;
    asked.current = true;
    syncNow();
  }, [onStep, syncNow]);
  const read = useQuery({ ...queries.githubAccounts(), enabled: onStep && sync.isError });
  return { loading: !sync.isSuccess && !(sync.isError && !read.isPending) };
}

export function WhereView({
  host,
  onWorkspaceSetUp,
}: {
  host: Host;
  /** An account was set up from here: Fresh start opens on it. */
  onWorkspaceSetUp: (workspaceId: string) => void;
}) {
  const { queries, mutations } = usePonzu();
  // What the arrival sync, or the read after it, put in the cache; and each sync after.
  const accounts = useQuery({ ...queries.githubAccounts(), enabled: false });
  const sync = useMutation(mutations.syncGithub());
  const confirm = useMutation(mutations.recordOnboarding());
  const [settingUp, setSettingUp] = useState<number | null>(null);
  const [notice, setNotice] = useState<InstallNotice | null>(null);
  const syncNow = sync.mutate;
  // The step opened on a sync that just answered.
  const lastSync = useRef(Date.now());
  const shown = useRef(accounts.data);
  shown.current = accounts.data;

  /** Ask GitHub again, then stop waiting on the row that was being set up. */
  const resync = useCallback(() => {
    lastSync.current = Date.now();
    const before = JSON.stringify(shown.current);
    syncNow(undefined, {
      // A list that changed answers what was asked of the owners, or the install that failed.
      onSuccess: (answer) => {
        if (JSON.stringify(answer) !== before) setNotice(null);
      },
      onError: () => setNotice("failed"),
      onSettled: () => setSettingUp(null),
    });
  }, [syncNow]);

  useEffect(() => {
    const back = () => {
      if (Date.now() - lastSync.current >= FOCUS_SYNC_MS) resync();
    };
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, [resync]);

  useEffect(
    () =>
      host.onLink((link: DeepLink) => {
        if (link.kind !== "github_setup") return;
        setNotice(link.result === "requested" || link.result === "failed" ? link.result : null);
        if (link.result === "installed" && link.workspaceId) onWorkspaceSetUp(link.workspaceId);
        resync();
      }),
    [host, resync, onWorkspaceSetUp],
  );

  // Once GitHub is done, Ponzu comes forward and the link listener above takes it from there,
  // whether or not this build takes the setup page's link (host.installGithub).
  const open = (githubAccountId?: number) => {
    setNotice(null);
    host.installGithub(githubAccountId ? { githubAccountId } : {}).catch(() => {
      setSettingUp(null);
      setNotice("failed");
    });
  };

  const list: GithubAccount[] | "loading" | "failed" = accounts.data
    ? accounts.data.accounts
    : accounts.isFetching
      ? "loading"
      : "failed";

  return (
    <WhereStep
      accounts={list}
      settingUp={settingUp}
      notice={notice}
      onSetUp={(account) => {
        setSettingUp(account.githubAccountId);
        open(account.githubAccountId);
      }}
      onOtherOrganization={() => open()}
      onRetry={() => void accounts.refetch()}
      onContinue={() => confirm.mutate("where")}
      continuing={confirm.isPending}
    />
  );
}
