/*
 * Stand-ins for the data layer around guided setup and Settings: local state and a few timers
 * where the API will be, so every composition can be clicked through.
 */
import { type ReactNode, useState } from "react";
import type { ClaudeConnection, ClaudeLimit } from "../claude.ts";
import type { Effort, Repo, Workspace } from "../model.ts";
import { AccountSection } from "../settings/account.tsx";
import { AgentsSection } from "../settings/agents.tsx";
import type { PersonUsage, Usage } from "../settings/billing.ts";
import type { RepoEnvironment } from "../settings/environments.ts";
import { EnvironmentsSection } from "../settings/environments.tsx";
import { GithubSection, type Installation } from "../settings/github.tsx";
import type { Member } from "../settings/members.ts";
import { MembersSection } from "../settings/members.tsx";
import { NotificationsSection, type PingDevice } from "../settings/notifications.tsx";
import { type DesignUsage, PlanSection } from "../settings/plan.tsx";
import {
  SettingsModal,
  SettingsPanel,
  type SettingsSection,
  sectionFor,
} from "../settings/settings-modal.tsx";
import type { ClaudeCardProps, ClaudeCardState } from "../setup/claude-card.tsx";
import { ClaudeStep } from "../setup/claude-step.tsx";
import { IphoneStep } from "../setup/iphone-step.tsx";
import type { GithubAccount } from "../setup/setup.ts";
import { type SignInState, SignInStep } from "../setup/sign-in.tsx";
import { type InstallNotice, WhereStep } from "../setup/where.tsx";
import { AppWindow } from "../window/app-window.tsx";
import * as f from "./fixtures.ts";
import { DesignChromeHarness, Harness } from "./harness.tsx";
import * as s from "./setup-fixtures.ts";

const ignore = () => {};
const later = (ms: number, run: () => void) => window.setTimeout(run, ms);

/** A Claude card that works: sign in opens the code step, a code of "wrong" is refused. */
export function useClaudeCard(initial: ClaudeCardState, onConnected: () => void): ClaudeCardProps {
  const [state, setState] = useState(initial);
  return {
    state,
    onSignIn: () => {
      setState({ mode: "choose", starting: true, failed: false });
      later(700, () => setState({ mode: "subscription", code: "", status: "idle" }));
    },
    onAddKey: () => setState({ mode: "api_key", key: "", status: "idle" }),
    onChange: () => setState({ mode: "choose", starting: false, failed: false }),
    onInput: (text) =>
      setState((st) =>
        st.mode === "subscription"
          ? { ...st, code: text, status: st.status === "expired" ? "expired" : "idle" }
          : st.mode === "api_key"
            ? { ...st, key: text, status: "idle" }
            : st,
      ),
    onReopen: () => setState({ mode: "subscription", code: "", status: "idle" }),
    onSubmit: () => {
      if (state.mode === "choose") return;
      const entered = state.mode === "subscription" ? state.code : state.key;
      setState({ ...state, status: "connecting" } as ClaudeCardState);
      later(900, () => {
        if (entered !== "wrong") return onConnected();
        setState(
          state.mode === "subscription"
            ? { ...state, status: "wrong" }
            : { ...state, status: "rejected" },
        );
      });
    },
  };
}

export type SetupStart =
  | { step: "sign_in"; state?: SignInState }
  | {
      step: "where";
      accounts: GithubAccount[] | "loading" | "failed";
      settingUp?: number | null;
      notice?: InstallNotice | null;
    }
  | { step: "claude"; card: ClaudeCardState }
  | { step: "iphone" };

/** The guided setup in its window, from `start` through to the end and round again. */
export function SetupHarness({ start }: { start: SetupStart }) {
  const [step, setStep] = useState<SetupStart>(start);
  return (
    <AppWindow lights="drawn" sidebar={null} rail={null}>
      {step.step === "sign_in" ? (
        <SignInStep
          state={step.state ?? "idle"}
          onContinue={() => {
            setStep({ step: "sign_in", state: "waiting" });
            later(900, () => setStep({ step: "where", accounts: s.accounts }));
          }}
        />
      ) : step.step === "where" ? (
        <WhereHarness
          start={step}
          onContinue={() =>
            setStep({ step: "claude", card: { mode: "choose", starting: false, failed: false } })
          }
        />
      ) : step.step === "claude" ? (
        <ClaudeHarness initial={step.card} onConnected={() => setStep({ step: "iphone" })} />
      ) : (
        <IphoneStep onStart={() => setStep({ step: "sign_in" })} />
      )}
    </AppWindow>
  );
}

function WhereHarness({
  start,
  onContinue,
}: {
  start: Extract<SetupStart, { step: "where" }>;
  onContinue: () => void;
}) {
  const [accounts, setAccounts] = useState(start.accounts);
  const [settingUp, setSettingUp] = useState(start.settingUp ?? null);
  return (
    <WhereStep
      accounts={accounts}
      settingUp={settingUp}
      notice={start.notice ?? null}
      onSetUp={(account) => {
        setSettingUp(account.githubAccountId);
        // Back from GitHub's install page: the row turns Ready.
        later(1200, () => {
          setSettingUp(null);
          setAccounts((list) =>
            Array.isArray(list)
              ? list.map((a) =>
                  a.githubAccountId === account.githubAccountId
                    ? { ...a, status: "ready", workspaceId: "ws_new" }
                    : a,
                )
              : list,
          );
        });
      }}
      onOtherOrganization={ignore}
      onRetry={() => {
        setAccounts("loading");
        later(700, () => setAccounts(s.accounts));
      }}
      onContinue={onContinue}
    />
  );
}

function ClaudeHarness({
  initial,
  onConnected,
}: {
  initial: ClaudeCardState;
  onConnected: () => void;
}) {
  return <ClaudeStep {...useClaudeCard(initial, onConnected)} />;
}

/** What Settings shows, all of it overridable per composition. */
export interface SettingsData {
  workspace: Workspace;
  workspaces: Workspace[];
  teams: { workspace: Workspace; role: Member["role"] }[];
  connection: ClaudeConnection | null;
  entry: ClaudeCardState | null;
  limits: ClaudeLimit[] | null;
  devices: PingDevice[];
  members: Member[];
  meId: string;
  syncFailed: boolean;
  installation: Installation;
  repos: Repo[];
  environments: RepoEnvironment[];
  open: string[];
  usage: Usage;
  byPerson: PersonUsage[] | null;
  /** Put down to nobody, beside `byPerson`. */
  unattributedCredits?: number;
  byDesign?: DesignUsage[];
}

export const TEAM_SETTINGS: SettingsData = {
  workspace: f.northbrook,
  workspaces: f.workspaces,
  teams: [{ workspace: f.northbrook, role: "admin" }],
  connection: s.claudeMax,
  entry: null,
  limits: s.limits,
  devices: [s.iphone],
  members: s.members,
  meId: f.bryce.id,
  syncFailed: false,
  installation: s.installation,
  repos: s.githubRepos,
  environments: s.environments,
  open: [f.fernwood.id],
  usage: s.teamUsage,
  byPerson: s.byPerson,
};

export const SOLO_SETTINGS: SettingsData = {
  ...TEAM_SETTINGS,
  workspace: f.personal,
  workspaces: [f.personal],
  teams: [],
  usage: s.soloUsage,
  byPerson: null,
};

/** Every section working on local state: toggles flip, roles change, secrets save. */
function useSettings(initial: SettingsData, section: SettingsSection) {
  const [data, setData] = useState(initial);
  const [current, setCurrent] = useState(section);
  const [prefs, setPrefs] = useState(s.pingPrefs);
  const [defaults, setDefaults] = useState({ model: f.models[0]!.id, effort: "high" as Effort });
  const set = (patch: Partial<SettingsData>) => setData((d) => ({ ...d, ...patch }));
  const entry = useClaudeCard(
    data.entry ?? { mode: "choose", starting: false, failed: false },
    () => set({ entry: null, connection: s.claudeMax }),
  );
  const team = data.workspace.kind === "org";
  const content: Record<SettingsSection, () => ReactNode> = {
    account: () => (
      <AccountSection
        me={f.bryce}
        email={s.email}
        teams={data.teams}
        onSignOut={ignore}
        onCreateTeam={ignore}
        onDelete={ignore}
      />
    ),
    agents: () => (
      <AgentsSection
        {...(data.connection
          ? { connection: data.connection, entry: data.entry ? entry : null }
          : { connection: null, entry })}
        onDisconnect={() => set({ connection: null })}
        onSwitch={() => {
          set({ entry: { mode: "choose", starting: false, failed: false } });
          if (data.connection?.method === "api_key") entry.onSignIn();
          else entry.onAddKey();
        }}
        onReconnect={() => {
          set({ entry: { mode: "choose", starting: false, failed: false } });
          entry.onSignIn();
        }}
        defaults={defaults}
        models={f.models}
        efforts={["low", "medium", "high", "xhigh", "max"]}
        onDefaultsChange={setDefaults}
        limits={data.connection?.method === "api_key" ? null : data.limits}
      />
    ),
    notifications: () => (
      <NotificationsSection
        prefs={prefs}
        onPrefsChange={setPrefs}
        devices={data.devices}
        onDeviceChange={(device, pings) =>
          set({ devices: data.devices.map((d) => (d.id === device.id ? { ...d, pings } : d)) })
        }
        email={s.email}
        team={data.workspaces.some((w) => w.kind === "org")}
        onGetIphone={ignore}
      />
    ),
    members: () => (
      <MembersSection
        workspace={data.workspace}
        members={data.members}
        meId={data.meId}
        onRoleChange={(member, role) =>
          set({
            members: data.members.map((m) =>
              m.person.id === member.person.id ? { ...m, role } : m,
            ),
          })
        }
        onManage={ignore}
        syncFailed={data.syncFailed}
      />
    ),
    plan: () => (
      <PlanSection
        usage={data.usage}
        team={
          team
            ? {
                name: data.workspace.name,
                people: data.members.length,
                byPerson: data.byPerson,
                unattributedCredits: data.unattributedCredits,
                mine: s.byPerson.find((p) => p.person.id === data.meId) ?? s.byPerson[0]!,
              }
            : null
        }
        byDesign={data.byDesign}
        canManage={!team || data.byPerson !== null}
        onCapChange={(capUsd) => set({ usage: { ...data.usage, capUsd } })}
        onManageCard={ignore}
        onAddCard={ignore}
      />
    ),
    github: () => (
      <GithubSection
        installation={{ ...data.installation, accountLogin: data.workspace.login }}
        repos={data.repos}
        onManage={ignore}
        onInstall={ignore}
      />
    ),
    environments: () => (
      <EnvironmentsSection
        environments={data.environments}
        open={data.open}
        onOpenChange={(open) => set({ open })}
        canEdit={data.members.some((m) => m.person.id === data.meId && m.role === "admin")}
        onRebuild={(repo) => {
          const rebuild = (status: RepoEnvironment["base"]["status"]) =>
            setData((d) => ({
              ...d,
              environments: d.environments.map((e) =>
                e.repo.id === repo.id ? { ...e, base: { ...e.base, status } } : e,
              ),
            }));
          rebuild("building");
          later(2000, () => rebuild("ready"));
        }}
        onSaveSecret={(repo, name, value) =>
          set({
            environments: data.environments.map((e) =>
              e.repo.id !== repo.id || !value || e.secrets.some((x) => x.name === name)
                ? e
                : { ...e, secrets: [...e.secrets, { name, updatedAt: new Date().toISOString() }] },
            ),
          })
        }
        onRemoveSecret={(repo, name) =>
          set({
            environments: data.environments.map((e) =>
              e.repo.id === repo.id
                ? { ...e, secrets: e.secrets.filter((x) => x.name !== name) }
                : e,
            ),
          })
        }
      />
    ),
  };
  return {
    panel: {
      section: current,
      onSectionChange: setCurrent,
      workspace: data.workspace,
      workspaces: data.workspaces,
      onSwitchWorkspace: (workspace: Workspace) => {
        set({ workspace });
        setCurrent((c) => sectionFor(c, workspace));
      },
      onCreateTeam: ignore,
      children: content[current](),
    },
  };
}

/** Settings open over a design in its window, as the settings boards draw it. */
export function SettingsWindow({
  section,
  data = TEAM_SETTINGS,
}: {
  section: SettingsSection;
  data?: SettingsData;
}) {
  const [open, setOpen] = useState(true);
  const { panel } = useSettings(data, section);
  // The settings boards draw their window over the solo boards' design list.
  const quieter = f.soloDesigns.find((d) => d.id === "dsn_quieter")!;
  return (
    <>
      <Harness
        workspace={data.workspace.kind === "personal" ? f.personal : f.northbrook}
        designs={f.soloDesigns}
        openId={quieter.id}
        rail
        chrome={(sidebarOpen) => (
          <DesignChromeHarness
            design={quieter}
            sidebarOpen={sidebarOpen}
            contributors={null}
            railOpen
          />
        )}
      >
        {null}
      </Harness>
      <SettingsModal open={open} onOpenChange={setOpen} {...panel} />
    </>
  );
}

/** Settings drawn in place, for the states page: the panel at the modal's size. */
export function SettingsInPlace({
  section,
  data = TEAM_SETTINGS,
}: {
  section: SettingsSection;
  data?: SettingsData;
}) {
  const { panel } = useSettings(data, section);
  return (
    <div className="flex h-[600px] w-[760px] overflow-hidden rounded-16 bg-surface shadow-pop">
      <SettingsPanel {...panel} onClose={ignore} />
    </div>
  );
}
