import {
  Cancel01Icon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { PullRequestSummary } from "../model.ts";
import {
  type ChecksGlyph,
  checksGlyph,
  type PullRequestIconState,
  pullRequestIcon,
} from "../pull-request.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { overlayOpen, useShortcut } from "../ui/shortcut.ts";
import { Tip } from "../ui/tooltip.tsx";

/**
 * How loud a mark is. `colored` gives the icon and the checks their state's color (the pull
 * request tab open); `neutral` draws them in the text's color (the chrome at rest, the open
 * design's row).
 */
type Tone = "colored" | "neutral";

/** The icon for each state a pull request can be in. */
export const PULL_REQUEST_ICONS = {
  open: GitPullRequestIcon,
  draft: GitPullRequestIcon,
  conflict: GitPullRequestClosedIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
} as const;

const ICON_COLORS: Record<PullRequestIconState, string> = {
  open: "text-pr-open",
  draft: "text-icon-soft",
  conflict: "text-pr-conflict",
  closed: "text-muted",
  merged: "text-pr-merged",
};

const CHECK_LABELS: Record<ChecksGlyph, string> = {
  draft: "Draft",
  running: "Checks running",
  failing: "A check is failing",
  passing: "Checks passed",
};

/** The checks after the number: a draft's hollow dot, a running dot, a cross or a tick. */
export function ChecksMark({ glyph, tone }: { glyph: ChecksGlyph; tone: Tone }) {
  const colored = tone === "colored";
  return (
    <span role="img" aria-label={CHECK_LABELS[glyph]} className="flex items-center">
      {glyph === "draft" ? (
        <span
          className={cn("size-1.5 rounded-pill", colored ? "text-faint" : undefined)}
          style={{ boxShadow: "inset 0 0 0 1.5px currentColor" }}
        />
      ) : glyph === "running" ? (
        <span className={cn("size-1.5 rounded-pill bg-current", colored && "text-pr-running")} />
      ) : glyph === "failing" ? (
        <Icon
          icon={Cancel01Icon}
          size={10}
          stroke={2.6}
          className={cn(colored && "text-pr-failing")}
        />
      ) : (
        <Icon icon={Tick02Icon} size={10} stroke={2.6} className={cn(colored && "text-pr-open")} />
      )}
    </span>
  );
}

/** The pull request's icon and number, and, with `checks`, how its checks stand. */
export function PullRequestMark({
  pr,
  tone,
  checks,
}: {
  pr: PullRequestSummary;
  tone: Tone;
  checks: boolean;
}) {
  const state = pullRequestIcon(pr);
  const glyph = checks ? checksGlyph(pr) : null;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-11">
      <Icon
        icon={PULL_REQUEST_ICONS[state]}
        size={11}
        stroke={2}
        className={tone === "colored" ? ICON_COLORS[state] : undefined}
      />
      #{pr.number}
      {glyph ? <ChecksMark glyph={glyph} tone={tone} /> : null}
    </span>
  );
}

/**
 * The pull request mark in the chrome. It is the pull request tab: raised and in color while the
 * tab is open, muted like an inactive page tab otherwise. ⌘P toggles it.
 */
export function PullRequestTab({
  pr,
  active,
  onToggle,
}: {
  pr: PullRequestSummary;
  active: boolean;
  onToggle: () => void;
}) {
  // ⌘P shows and hides the pull request, as a click on the mark does: not under a menu, popover
  // or dialog (the key is left alone there), and once a press.
  useShortcut("p", onToggle, true, { once: true, when: () => !overlayOpen() });
  return (
    <Tip label={`Pull request #${pr.number}`} keys={["⌘", "P"]}>
      <Button
        variant="icon"
        aria-pressed={active}
        aria-label={`Pull request #${pr.number}`}
        onClick={onToggle}
        className={cn(
          "h-7 px-2.5",
          active
            ? "bg-raised text-ink shadow-raised hover:bg-raised"
            : "text-muted [&_svg]:text-icon-soft",
        )}
      >
        <PullRequestMark pr={pr} tone={active ? "colored" : "neutral"} checks />
      </Button>
    </Tip>
  );
}
