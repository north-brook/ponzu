import {
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  CreditCardIcon,
  Logout01Icon,
  PlusSignIcon,
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

/** The tile color of an account with no logo, the same for it everywhere. */
export function monogramColor(id: string): string {
  const hue = [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  return MONOGRAM_COLORS[hue % MONOGRAM_COLORS.length]!;
}

/**
 * A workspace's mark: an organization's logo, or a tile with its initial when it has none; a
 * personal workspace is the person's round avatar. 20px in the sidebar; Settings' nav takes 16.
 */
export function WorkspaceMark({ workspace, size = 20 }: { workspace: Workspace; size?: 16 | 20 }) {
  const round = workspace.kind === "personal";
  const shape = round ? "rounded-pill" : size === 16 ? "rounded-4" : "rounded-5";
  if (workspace.avatarUrl) {
    return (
      <img
        src={workspace.avatarUrl}
        alt=""
        draggable={false}
        className={cn("block shrink-0 object-cover", shape)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center font-display font-semibold leading-none",
        size === 16 ? "text-9" : "text-11",
        shape,
      )}
      // White on a dark tile in either theme.
      style={{
        width: size,
        height: size,
        background: monogramColor(workspace.login),
        color: "#ffffff",
      }}
    >
      {monogramLetter(workspace)}
    </span>
  );
}

/**
 * The letter on an account's tile, the same wherever it shows: a person's from their GitHub
 * login (a personal workspace is called "Personal", which isn't theirs), a team's from its name.
 */
export function monogramLetter(account: {
  kind: Workspace["kind"];
  name: string;
  login: string;
}): string {
  const from = account.kind === "personal" ? account.login : account.name || account.login;
  return from.trim().charAt(0).toUpperCase();
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
        <Icon icon={ArrowDown01Icon} step="meta" className="text-icon-soft" />
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
          leading={<Icon icon={PlusSignIcon} step="control" />}
          trailing={<Icon icon={ArrowUpRight01Icon} step="small" className="text-icon-soft" />}
          className="text-muted"
        >
          Set up another on GitHub
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={onSettings}
          leading={<Icon icon={Settings01Icon} step="control" className="text-muted" />}
          trailing={<Kbd>⌘,</Kbd>}
        >
          Settings
        </MenuItem>
        <MenuItem
          onSelect={onPlan}
          leading={<Icon icon={CreditCardIcon} step="control" className="text-muted" />}
        >
          Plan and usage
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={onSignOut}
          leading={<Icon icon={Logout01Icon} step="control" className="text-muted" />}
        >
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
