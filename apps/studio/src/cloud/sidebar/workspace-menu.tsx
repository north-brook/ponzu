import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  CreditCardIcon,
  Logout01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import type { Workspace } from "../model.ts";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { Kbd } from "../ui/kbd.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu.tsx";

/** Tiles for an organization with no logo: muted, so no workspace shouts. */
const MONOGRAM_COLORS = ["#5a4a3d", "#3d4a5a", "#5a3d50", "#3d5a40", "#4f5a3d", "#3d5a57"];

/**
 * A workspace's mark: an organization's logo, or a tile with its initial when it has none; a
 * personal workspace is the person's round avatar.
 */
export function WorkspaceMark({ workspace }: { workspace: Workspace }) {
  const round = workspace.kind === "personal";
  if (workspace.avatarUrl) {
    return (
      <img
        src={workspace.avatarUrl}
        alt=""
        draggable={false}
        className={cn("block size-5 shrink-0 object-cover", round ? "rounded-pill" : "rounded-5")}
      />
    );
  }
  const hue = [...workspace.id].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-5 shrink-0 place-items-center font-display font-semibold text-11 leading-none",
        round ? "rounded-pill" : "rounded-5",
      )}
      // White on a dark tile in either theme.
      style={{ background: MONOGRAM_COLORS[hue % MONOGRAM_COLORS.length], color: "#ffffff" }}
    >
      {workspaceName(workspace).charAt(0).toUpperCase()}
    </span>
  );
}

export function workspaceName(workspace: Workspace): string {
  return workspace.kind === "personal" ? "Personal" : workspace.name;
}

/**
 * The sidebar's first control: the workspace you are in, opening the team menu. It switches
 * workspace, sets up another through GitHub, and is the way into Settings, Plan and usage, and
 * Sign out.
 */
export function WorkspaceMenu({
  current,
  workspaces,
  onSwitch,
  onAddWorkspace,
  onSettings,
  onPlan,
  onSignOut,
}: {
  current: Workspace;
  workspaces: Workspace[];
  onSwitch: (workspace: Workspace) => void;
  onAddWorkspace: () => void;
  onSettings: () => void;
  onPlan: () => void;
  onSignOut: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Workspace: ${workspaceName(current)}`}
        className="app-no-drag -ml-1.5 flex h-7 shrink-0 cursor-default select-none items-center gap-2 rounded-7 px-1.5 outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover active:bg-press aria-expanded:bg-hover"
      >
        <WorkspaceMark workspace={current} />
        <span className="font-semibold text-13">{workspaceName(current)}</span>
        <Icon icon={ArrowDown01Icon} size={11} stroke={2.2} className="text-icon-soft" />
      </MenuTrigger>
      <MenuContent width={260} side="bottom" align="start" sideOffset={7} alignOffset={-2}>
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
        <MenuItem
          onSelect={onAddWorkspace}
          leading={<Icon icon={Add01Icon} size={16} stroke={1.8} className="text-icon-soft" />}
          trailing={<Icon icon={ArrowUpRight01Icon} size={12} stroke={2} className="text-faint" />}
          className="text-muted"
        >
          Set up another on GitHub
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={onSettings}
          leading={<Icon icon={Settings01Icon} size={16} stroke={1.8} className="text-muted" />}
          trailing={<Kbd>⌘,</Kbd>}
        >
          Settings
        </MenuItem>
        <MenuItem
          onSelect={onPlan}
          leading={<Icon icon={CreditCardIcon} size={16} stroke={1.8} className="text-muted" />}
        >
          Plan and usage
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={onSignOut}
          leading={<Icon icon={Logout01Icon} size={16} stroke={1.8} className="text-muted" />}
        >
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
