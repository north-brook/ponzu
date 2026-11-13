import type { Api, Profile } from "@ponzu/client";
import { useMemo, useState } from "react";
import type { Person } from "../../cloud/model.ts";
import {
  SettingsModal,
  type SettingsSection,
  sectionFor,
} from "../../cloud/settings/settings-modal.tsx";
import type { Host } from "../host.ts";
import { toWorkspace } from "../map.ts";
import { AccountView } from "./account-view.tsx";
import { AgentsView } from "./agents-view.tsx";
import { EnvironmentsView } from "./environments-view.tsx";
import { GithubView } from "./github-view.tsx";
import { MembersView } from "./members-view.tsx";
import { NotificationsView } from "./notifications-view.tsx";
import { PlanView } from "./plan-view.tsx";

/*
 * Settings (⌘, and the team menu), on live data: every section, each on its own routes. Its
 * workspace sections start on the window's workspace and have their own switcher, which changes
 * only them. The iPhone row of Notifications, with no phone yet, leads to the guided setup's
 * step for it (`onGetIphone`).
 */

type MeWorkspace = Awaited<ReturnType<Api["me"]>>["workspaces"][number];

export function SettingsView({
  host,
  me,
  user,
  workspaces,
  workspaceId,
  open,
  onOpenChange,
  section,
  onSectionChange,
  onAddWorkspace,
  onGetIphone,
}: {
  host: Host;
  me: Person;
  user: Profile;
  /** The workspaces the person can work in. */
  workspaces: MeWorkspace[];
  /** The window's workspace: where the workspace's sections start. */
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  /** Set Ponzu up on another GitHub account. */
  onAddWorkspace: () => void;
  /** Show how to get Ponzu on an iPhone. */
  onGetIphone: () => void;
}) {
  const shown = useMemo(() => workspaces.map(toWorkspace), [workspaces]);
  // Settings has its own switcher: choosing a workspace here changes only its sections.
  const [chosenId, setChosenId] = useState(workspaceId);
  const chosen = workspaces.find((w) => w.id === chosenId) ?? workspaces[0];
  if (!chosen) return null;
  const workspace = toWorkspace(chosen);
  const current = sectionFor(section, workspace);
  const teams = workspaces
    .filter((w) => w.kind === "org")
    .map((w) => ({ workspace: toWorkspace(w), role: w.role }));

  return (
    <SettingsModal
      open={open}
      onOpenChange={onOpenChange}
      section={current}
      onSectionChange={onSectionChange}
      workspace={workspace}
      workspaces={shown}
      onSwitchWorkspace={(next) => {
        setChosenId(next.id);
        onSectionChange(sectionFor(current, next));
      }}
      onCreateTeam={onAddWorkspace}
    >
      {current === "account" ? (
        <AccountView
          host={host}
          me={me}
          email={user.email}
          teams={teams}
          onCreateTeam={onAddWorkspace}
        />
      ) : current === "agents" ? (
        <AgentsView host={host} />
      ) : current === "notifications" ? (
        <NotificationsView email={user.email} team={teams.length > 0} onGetIphone={onGetIphone} />
      ) : current === "members" ? (
        <MembersView host={host} workspace={workspace} meId={me.id} />
      ) : current === "plan" ? (
        <PlanView key={workspace.id} workspace={workspace} host={host} />
      ) : current === "github" ? (
        <GithubView host={host} workspaceId={workspace.id} />
      ) : (
        <EnvironmentsView key={workspace.id} workspaceId={workspace.id} />
      )}
    </SettingsModal>
  );
}
