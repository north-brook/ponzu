import {
  ArrowDown01Icon,
  BotIcon,
  Cancel01Icon,
  CreditCardIcon,
  GithubIcon,
  Notification01Icon,
  PlusSignIcon,
  ServerStack01Icon,
  UserCircleIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import type { Workspace } from "../model.ts";
import { WorkspaceMark, workspaceName } from "../sidebar/workspace-menu.tsx";
import { IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon, type IconSvgElement } from "../ui/icon.tsx";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu.tsx";
import { Modal } from "../ui/modal.tsx";
import { useShortcut } from "../ui/shortcut.ts";

export type SettingsSection =
  | "account"
  | "agents"
  | "notifications"
  | "members"
  | "plan"
  | "github"
  | "environments";

const SECTIONS: Record<SettingsSection, { title: string; icon: IconSvgElement }> = {
  account: { title: "Account", icon: UserCircleIcon },
  agents: { title: "Agents", icon: BotIcon },
  notifications: { title: "Notifications", icon: Notification01Icon },
  members: { title: "Members", icon: UserGroupIcon },
  plan: { title: "Plan and usage", icon: CreditCardIcon },
  github: { title: "GitHub", icon: GithubIcon },
  environments: { title: "Environments", icon: ServerStack01Icon },
};

const PERSONAL: SettingsSection[] = ["account", "agents", "notifications"];

/** The sections of a workspace: a personal one has no Members, since nobody else is in it. */
export function workspaceSections(workspace: Workspace): SettingsSection[] {
  return workspace.kind === "personal"
    ? ["plan", "github", "environments"]
    : ["members", "plan", "github", "environments"];
}

/**
 * Where a section stands when the workspace changes under it: Members has nothing to show for a
 * personal workspace, so it gives way to Plan and usage.
 */
export function sectionFor(section: SettingsSection, workspace: Workspace): SettingsSection {
  return section === "members" && workspace.kind === "personal" ? "plan" : section;
}

export interface SettingsPanelProps {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  /** The workspace the lower sections are about. */
  workspace: Workspace;
  workspaces: Workspace[];
  onSwitchWorkspace: (workspace: Workspace) => void;
  /** Set Ponzu up on another GitHub account, from the solo nav's foot. */
  onCreateTeam: () => void;
  onClose: () => void;
  /** The chosen section's content. */
  children: ReactNode;
}

/**
 * Settings: the nav on the left, the chosen section on the right under its title. Personal
 * sections come first. Once the person is in a team, the workspace's sections sit under its
 * name, which switches workspace; until then everything is one list, with Create a team at the
 * foot.
 */
export function SettingsPanel({
  section,
  onSectionChange,
  workspace,
  workspaces,
  onSwitchWorkspace,
  onCreateTeam,
  onClose,
  children,
}: SettingsPanelProps) {
  const team = workspaces.some((w) => w.kind === "org");
  const item = (s: SettingsSection) => (
    <NavItem key={s} section={s} active={s === section} onSelect={() => onSectionChange(s)} />
  );
  return (
    <div className="flex h-full w-full">
      <nav
        aria-label="Settings"
        className="flex w-[190px] shrink-0 flex-col gap-0.5 bg-secondary px-2.5 py-3.5"
      >
        {PERSONAL.map(item)}
        {team ? (
          <>
            <span className="h-2.5 shrink-0" />
            <WorkspaceSwitcher
              current={workspace}
              workspaces={workspaces}
              onSwitch={onSwitchWorkspace}
            />
            {workspaceSections(workspace).map(item)}
          </>
        ) : (
          <>
            {workspaceSections(workspace).map(item)}
            <span className="flex-1" />
            <button
              type="button"
              onClick={onCreateTeam}
              className="flex h-8 shrink-0 cursor-default items-center gap-[9px] rounded-8 px-2.5 text-13 text-faint outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover hover:text-muted"
            >
              <Icon icon={PlusSignIcon} step="control" />
              Create a team
            </button>
          </>
        )}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col pt-6">
        <div className="flex shrink-0 items-center gap-2.5 px-7">
          <h2 className="m-0 flex-1 font-display font-semibold text-18 text-ink leading-none">
            {SECTIONS[section].title}
          </h2>
          <IconButton
            label="Close"
            keys={["esc"]}
            onClick={onClose}
            className="-my-1.5 -mr-1.5 size-7 text-icon-soft hover:text-ink"
          >
            <Icon icon={Cancel01Icon} step="control" />
          </IconButton>
        </div>
        <FadeScroll className="flex-1">
          <div className="flex flex-col gap-[22px] px-7 pt-[22px] pb-6">{children}</div>
        </FadeScroll>
      </div>
    </div>
  );
}

function NavItem({
  section,
  active,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  onSelect: () => void;
}) {
  const { title, icon } = SECTIONS[section];
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "flex h-8 shrink-0 cursor-default items-center gap-[9px] rounded-8 px-2.5 text-left text-13 outline-none transition-colors duration-(--dur-hover) focus-ring",
        active ? "bg-hover font-medium text-ink" : "text-muted hover:bg-hover",
      )}
    >
      <Icon icon={icon} step="control" />
      {title}
    </button>
  );
}

/** The workspace's name heading its sections, which opens the list of the person's workspaces. */
function WorkspaceSwitcher({
  current,
  workspaces,
  onSwitch,
}: {
  current: Workspace;
  workspaces: Workspace[];
  onSwitch: (workspace: Workspace) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Workspace: ${workspaceName(current)}`}
        className="mb-0.5 flex h-[30px] shrink-0 cursor-default items-center gap-2 rounded-8 px-2.5 outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover aria-expanded:bg-hover"
      >
        <WorkspaceMark workspace={current} size={16} />
        <span className="flex-1 truncate text-left font-semibold text-13 text-ink">
          {workspaceName(current)}
        </span>
        <Icon icon={ArrowDown01Icon} step="meta" className="text-icon-soft" />
      </MenuTrigger>
      <MenuContent width={260} side="bottom" align="start" sideOffset={4}>
        <MenuRadioGroup
          value={current.id}
          onValueChange={(id) => {
            const next = workspaces.find((w) => w.id === id);
            if (next) onSwitch(next);
          }}
        >
          {workspaces.map((w) => (
            <MenuRadioItem
              key={w.id}
              value={w.id}
              textValue={workspaceName(w)}
              leading={<WorkspaceMark workspace={w} />}
            >
              {workspaceName(w)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/**
 * Settings over the window: 760 by 600 (less, in a short window), the section's content
 * scrolling under its title. ⌘, opens it from anywhere; Escape, the close button or a click on
 * the dim closes it.
 */
export function SettingsModal({
  open,
  onOpenChange,
  ...panel
}: Omit<SettingsPanelProps, "onClose"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useShortcut(",", () => onOpenChange(true), !open);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      dim="settings"
      className="h-[min(600px,calc(100vh-60px))] w-[760px]"
    >
      <SettingsPanel {...panel} onClose={() => onOpenChange(false)} />
    </Modal>
  );
}
