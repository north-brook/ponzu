import {
  Alert02Icon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { NextAction } from "../pull-request.ts";
import { Button } from "../ui/button.tsx";
import { Icon, type IconSvgElement } from "../ui/icon.tsx";
import { Tip } from "../ui/tooltip.tsx";

const ACTIONS: Record<NextAction, { label: string; icon: IconSvgElement }> = {
  create_pr: { label: "Create PR", icon: GitPullRequestIcon },
  ready: { label: "Ready", icon: CheckmarkCircle01Icon },
  auto_merge: { label: "Auto-merge", icon: Clock01Icon },
  auto_merge_on: { label: "Auto-merge on", icon: Clock01Icon },
  fix_checks: { label: "Fix checks", icon: Wrench01Icon },
  resolve: { label: "Resolve", icon: Alert02Icon },
  update_branch: { label: "Update branch", icon: GitBranchIcon },
  merge: { label: "Merge", icon: GitMergeIcon },
  blocked: { label: "Merge", icon: GitMergeIcon },
};

/**
 * The chrome's one dark button: the next best thing to do with the design's pull request. While
 * `busy` (a merge GitHub hasn't answered) it holds still and disabled. Auto-merge, once on, and
 * an action `blocked` (actionBlock: no write access, or the agent's Claude can't run) fade and
 * can't be pressed, but stay in reach so their tip says why.
 */
export function NextActionButton({
  action,
  busy = false,
  blocked = null,
  onRun,
}: {
  action: NextAction;
  busy?: boolean;
  blocked?: string | null;
  onRun: (action: NextAction) => void;
}) {
  const { label, icon } = ACTIONS[action];
  const why = blocked ?? (action === "auto_merge_on" ? "Merges once the checks pass" : null);
  const button = (
    <Button
      variant="action"
      disabled={busy}
      aria-busy={busy || undefined}
      aria-disabled={why ? true : undefined}
      onClick={why ? undefined : () => onRun(action)}
      className="aria-disabled:opacity-35 aria-disabled:hover:bg-action aria-disabled:active:bg-action"
    >
      <Icon icon={icon} size={13} stroke={2} />
      {label}
    </Button>
  );
  return why ? <Tip label={why}>{button}</Tip> : button;
}
