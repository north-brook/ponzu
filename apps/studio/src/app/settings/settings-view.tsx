import type { Api, Profile } from "@ponzu/client";
import { useMemo, useState } from "react";
import type { Person } from "../../cloud/model.ts";
import { AccountSection } from "../../cloud/settings/account.tsx";
import {
  SettingsModal,
  type SettingsSection,
  sectionFor,
} from "../../cloud/settings/settings-modal.tsx";
import type { Host } from "../host.ts";
import { toWorkspace } from "../map.ts";
import { AgentsView } from "./agents-view.tsx";
import { GithubView } from "./github-view.tsx";
import { MembersView } from "./members-view.tsx";

/*
 * Settings (⌘, and the team menu), on live data: each section the API has something behind.
 *
 * SEAM(settings api): Notifications, Plan and usage and Environments wait on routes another
 * track is adding under /v1 (ping preferences and devices, credits and usage, repo
 * environments). Until they land, those sections are left out of the nav entirely, rather than
 * shown empty or made up; wiring one is taking it out of this list.
 */
export const SECTIONS_WITHOUT_AN_API: readonly SettingsSection[] = [
  "notifications",
  "plan",
  "environments",
];

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
}) {
  const shown = useMemo(() => workspaces.map(toWorkspace), [workspaces]);
  // Settings has its own switcher: choosing a workspace here changes only its sections.
  const [chosenId, setChosenId] = useState(workspaceId);
  const chosen = workspaces.find((w) => w.id === chosenId) ?? workspaces[0];
  if (!chosen) return null;
  const workspace = toWorkspace(chosen);
  const current = sectionFor(section, workspace);

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
      hidden={SECTIONS_WITHOUT_AN_API}
    >
      {current === "account" ? (
        <AccountSection
          me={me}
          email={user.email}
          teams={workspaces
            .filter((w) => w.kind === "org")
            .map((w) => ({ workspace: toWorkspace(w), role: w.role }))}
          onSignOut={() => void host.session.signOut()}
          onCreateTeam={onAddWorkspace}
          // There is no way to delete an account in the API yet, so there is no Danger zone.
        />
      ) : current === "agents" ? (
        <AgentsView host={host} />
      ) : current === "members" ? (
        <MembersView host={host} workspace={workspace} meId={me.id} />
      ) : current === "github" ? (
        <GithubView host={host} workspaceId={workspace.id} />
      ) : null}
    </SettingsModal>
  );
}
