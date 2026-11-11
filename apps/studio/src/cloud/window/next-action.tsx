import {
  Alert02Icon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  GitMergeIcon,
  GitPullRequestIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { NextAction } from "../pull-request.ts";
import { Button } from "../ui/button.tsx";
import { Icon, type IconSvgElement } from "../ui/icon.tsx";

const ACTIONS: Record<NextAction, { label: string; icon: IconSvgElement }> = {
  create_pr: { label: "Create PR", icon: GitPullRequestIcon },
  ready: { label: "Ready", icon: CheckmarkCircle01Icon },
  auto_merge: { label: "Auto-merge", icon: Clock01Icon },
  auto_merge_on: { label: "Auto-merge on", icon: Clock01Icon },
  fix_checks: { label: "Fix checks", icon: Wrench01Icon },
  resolve: { label: "Resolve", icon: Alert02Icon },
  merge: { label: "Merge", icon: GitMergeIcon },
};

/**
 * The chrome's one dark button: the next best thing to do with the design's pull request. While
 * `busy` (a merge GitHub hasn't answered) it holds still and disabled; auto-merge, once on, is
 * shown and can't be pressed again.
 */
export function NextActionButton({
  action,
  busy = false,
  onRun,
}: {
  action: NextAction;
  busy?: boolean;
  onRun: (action: NextAction) => void;
}) {
  const { label, icon } = ACTIONS[action];
  return (
    <Button
      variant="action"
      disabled={busy || action === "auto_merge_on"}
      aria-busy={busy || undefined}
      onClick={() => onRun(action)}
    >
      <Icon icon={icon} size={13} stroke={2} />
      {label}
    </Button>
  );
}
