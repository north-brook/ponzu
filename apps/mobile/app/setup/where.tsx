import {
  accountLabel,
  canContinue,
  type GithubAccount,
  type InstallNotice,
  installNotice,
} from "@ponzu/client/model/setup";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Text, View } from "react-native";
import { Check } from "../../components/icons";
import {
  AccountMark,
  Card,
  PillButton,
  RowButton,
  SetupRow,
  StepLayout,
  StepNote,
  TextButton,
} from "../../components/step";
import { backend } from "../../lib/cloud/backend";
import { config } from "../../lib/cloud/config";
import { type InstallOutcome, onInstallOutcome, runInstall } from "../../lib/cloud/install";
import { useCloud } from "../../lib/cloud/query";
import { useSignOut } from "../../lib/cloud/use-sign-out";
import { rememberWorkspace } from "../../lib/cloud/workspace";
import { SETUP, WHERE } from "../../lib/copy";
import { fail, success, tick } from "../../lib/haptics";
import { Juice } from "../../lib/slice";
import { useTheme } from "../../lib/theme";

/** Coming back to the app asks GitHub again, but not more often than this (as the Mac). */
const FOCUS_SYNC_MS = 2_000;

/** Which install page is open: an account's, or GitHub's own for another organization. */
type SettingUp = number | "other" | null;

/**
 * Where do you build? (onboarding 4.9, in the Mac's current words): the person's own GitHub
 * account, then each organization where Ponzu is installed. Set up opens GitHub's install page
 * in the system's auth session (lib/cloud/install.ts); when it is done the row turns Ready.
 * Continue records the step and the gate moves on to Connect Claude (lib/cloud/gate.ts).
 *
 * The list comes from a sync with GitHub as the step opens, as on the Mac: what the last
 * sign-in's sync saw may be old. If the sync fails the accounts are read instead, and if that
 * fails too the step says so.
 */
export default function Where() {
  const { color } = useTheme();
  const cloud = useCloud();
  const signOut = useSignOut();
  const sync = useMutation(cloud.mutations.syncGithub());
  // What the arrival sync put in the cache; read from the API only if that sync failed.
  const accounts = useQuery({ ...cloud.queries.githubAccounts(), enabled: sync.isError });
  const confirm = useMutation(cloud.mutations.recordOnboarding());
  const [settingUp, setSettingUp] = useState<SettingUp>(null);
  const [notice, setNotice] = useState<InstallNotice | null>(null);
  const [leaving, setLeaving] = useState(false);
  const installing = useRef(false);
  const lastSync = useRef(0);
  const shown = useRef(accounts.data);
  shown.current = accounts.data;
  const syncNow = sync.mutate;

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
      // A sync that answers while an install page is still open (the one as the step opened,
      // or coming back to the app) leaves its row waiting: the install's own end clears it.
      onSettled: () => {
        if (!installing.current) setSettingUp(null);
      },
    });
  }, [syncNow]);

  // GitHub, asked once as the step opens.
  useEffect(() => {
    resync();
  }, [resync]);

  // Back in front (from Safari, or another app): GitHub may have changed.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active" || installing.current) return;
      if (Date.now() - lastSync.current >= FOCUS_SYNC_MS) resync();
    });
    return () => sub.remove();
  }, [resync]);

  const heard = useCallback(
    (outcome: InstallOutcome) => {
      if (outcome.result === "closed") return;
      const next = installNotice(outcome.result);
      setNotice(next);
      if (next === "failed") fail();
      if (outcome.result === "installed") {
        success();
        if ("workspaceId" in outcome && outcome.workspaceId && cloud.userId) {
          void rememberWorkspace(cloud.userId, outcome.workspaceId);
        }
      }
    },
    [cloud.userId],
  );

  // The setup page's link, when it reaches the app outside the auth session (app/github/setup).
  useEffect(
    () =>
      onInstallOutcome((outcome) => {
        heard(outcome);
        resync();
      }),
    [heard, resync],
  );

  const open = async (githubAccountId?: number) => {
    if (installing.current) return;
    installing.current = true;
    tick();
    setNotice(null);
    setSettingUp(githubAccountId ?? "other");
    try {
      heard(
        await runInstall({
          github: backend.api.github,
          ...(githubAccountId ? { githubAccountId } : {}),
          scheme: config().scheme,
          openAuthSession: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
          dismissAuthSession: () => WebBrowser.dismissAuthSession(),
        }),
      );
    } catch {
      // The install page couldn't be had.
      fail();
      setNotice("failed");
    } finally {
      installing.current = false;
      // However it ended, even with the sheet closed early: GitHub says what is set up now.
      resync();
    }
  };

  const list: GithubAccount[] | "loading" | "failed" = accounts.data
    ? accounts.data.accounts
    : sync.isError && !accounts.isPending
      ? "failed"
      : "loading";

  const leave = async () => {
    if (leaving) return;
    setLeaving(true);
    await signOut();
  };

  return (
    <StepLayout
      testID="setup-where"
      progress={1}
      title={WHERE.title}
      body={WHERE.body}
      actions={
        <View style={{ gap: 6 }}>
          {confirm.isError ? (
            <StepNote tone="danger" testID="setup-where-continue-failed">
              {SETUP.continueFailed}
            </StepNote>
          ) : null}
          <PillButton
            testID="setup-where-continue"
            label={WHERE.continue}
            disabled={!Array.isArray(list) || !canContinue(list)}
            busy={confirm.isPending || confirm.isSuccess}
            onPress={() => confirm.mutate("where", { onError: () => fail() })}
          />
          <TextButton
            testID="setup-sign-out"
            label={SETUP.signOut}
            disabled={leaving}
            onPress={() => void leave()}
          />
        </View>
      }
    >
      {list === "loading" ? (
        <Card style={{ height: 57, alignItems: "center", justifyContent: "center" }}>
          <View testID="setup-where-loading" accessible accessibilityLabel={WHERE.loading}>
            <Juice size={15} color={color.faint} />
          </View>
        </Card>
      ) : list === "failed" ? (
        <Card
          style={{
            height: 57,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          <Text style={{ fontFamily: "Inter", fontSize: 14, color: color.muted }}>
            {WHERE.unreachable}
          </Text>
          <RowButton testID="setup-where-retry" label={WHERE.retry} onPress={resync} />
        </Card>
      ) : (
        <Card>
          {list.map((account, i) => (
            <AccountRow
              key={account.githubAccountId}
              account={account}
              last={i === list.length - 1}
              waiting={settingUp === account.githubAccountId}
              blocked={settingUp !== null}
              onSetUp={() => void open(account.githubAccountId)}
            />
          ))}
        </Card>
      )}
      {notice ? (
        <StepNote tone={notice === "failed" ? "danger" : "muted"} testID="setup-where-notice">
          {notice === "requested" ? WHERE.requested : WHERE.failed}
        </StepNote>
      ) : null}
      <View style={{ marginTop: notice ? 4 : 10, alignItems: "center" }}>
        <TextButton
          testID="setup-where-other"
          label={`${WHERE.otherOrganization} ↗`}
          disabled={settingUp !== null}
          onPress={() => void open()}
        />
      </View>
    </StepLayout>
  );
}

function AccountRow({
  account,
  last,
  waiting,
  blocked,
  onSetUp,
}: {
  account: GithubAccount;
  last: boolean;
  /** This account's install page is open. */
  waiting: boolean;
  /** Another install page is open. */
  blocked: boolean;
  onSetUp: () => void;
}) {
  const { color } = useTheme();
  const { title, line } = accountLabel(account);
  return (
    <SetupRow
      testID={`setup-account-${account.login}`}
      last={last}
      mark={
        <AccountMark
          avatarUrl={account.avatarUrl}
          login={account.login}
          personal={account.kind === "personal"}
        />
      }
      title={title}
      line={line}
    >
      {account.status === "not_installed" ? (
        <RowButton
          testID={`setup-account-${account.login}-set-up`}
          label={WHERE.setUp}
          accessibilityLabel={`${WHERE.setUp} ${title}`}
          busy={waiting}
          disabled={blocked && !waiting}
          onPress={onSetUp}
        />
      ) : account.suspended ? (
        <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 13, color: color.muted }}>
          {WHERE.suspended}
        </Text>
      ) : (
        <View
          accessible
          accessibilityLabel={`${title}, ${WHERE.ready}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
        >
          <Check size={14} color={color.ink} />
          <Text
            style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 13, color: color.muted }}
          >
            {WHERE.ready}
          </Text>
        </View>
      )}
    </SetupRow>
  );
}
