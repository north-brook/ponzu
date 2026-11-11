import type { DeepLink } from "@ponzu/desktop/bridge";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GithubAccount } from "../../cloud/setup/setup.ts";
import { type InstallNotice, WhereStep } from "../../cloud/setup/where.tsx";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";

/*
 * "Where do you design?", live: the person's GitHub accounts, Set up opening GitHub's install
 * page in the browser, and on coming back (Ponzu's ponzu://github/setup link, or the window
 * coming to the front) a sync with GitHub, which turns the row Ready. Continue records the
 * step, and the gates move on.
 */

/** Coming back to the window asks GitHub again, but not more often than this. */
const FOCUS_SYNC_MS = 2_000;

export function WhereView({
  host,
  onWorkspaceSetUp,
}: {
  host: Host;
  /** An account was set up from here: Fresh start opens on it. */
  onWorkspaceSetUp: (workspaceId: string) => void;
}) {
  const { queries, mutations } = usePonzu();
  const accounts = useQuery(queries.githubAccounts());
  const sync = useMutation(mutations.syncGithub());
  const installLink = useMutation(mutations.installLink());
  const confirm = useMutation(mutations.recordOnboarding());
  const [settingUp, setSettingUp] = useState<number | null>(null);
  const [notice, setNotice] = useState<InstallNotice | null>(null);
  const syncNow = sync.mutate;
  const lastSync = useRef(0);

  /** Ask GitHub again, then stop waiting on the row that was being set up. */
  const resync = useCallback(() => {
    lastSync.current = Date.now();
    syncNow(undefined, { onSettled: () => setSettingUp(null) });
  }, [syncNow]);

  // On arriving, GitHub is asked once: what the last sign-in's sync saw may be old.
  useEffect(() => resync(), [resync]);

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

  const open = (githubAccountId?: number) => {
    setNotice(null);
    installLink.mutate(
      { client: "mac", ...(githubAccountId ? { githubAccountId } : {}) },
      {
        onSuccess: ({ url }) => host.openExternal(url),
        onError: () => {
          setSettingUp(null);
          setNotice("failed");
        },
      },
    );
  };

  const list: GithubAccount[] | "loading" | "failed" = accounts.data
    ? accounts.data.accounts
    : accounts.isError
      ? "failed"
      : "loading";

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
