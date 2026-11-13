import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  Comment01Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  LinkSquare02Icon,
  MinusSignIcon,
  Tick02Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import { ApiError, type CanvasHeadRow } from "@ponzu/client";
import {
  ago,
  bodyForTab,
  type CheckRun,
  duration,
  type NextAction,
  orderChecks,
  type PrComment,
  type PrFile,
  type PullRequestDetail,
  pullRequestIcon,
  toPullRequestDetail,
} from "@ponzu/client/model";
import { MutationObserver, useQuery } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { backend } from "../lib/cloud/backend";
import { useCloud } from "../lib/cloud/query";
import { CHAT, PR } from "../lib/copy";
import { fail, select, success, tick } from "../lib/haptics";
import { Markdown } from "../lib/markdown";
import { safeHref } from "../lib/prose";
import { authorName, checksLine, PrActions, prFoot, reviewsLine } from "../lib/pull-request";
import { useTheme } from "../lib/theme";
import { font } from "../lib/tokens";
import { Diff } from "./diff";
import { Glass } from "./glass";
import { Back, Chevron } from "./icons";
import { Sheet } from "./sheet";

/**
 * The pull request's colors when its mark is active, as the Mac's (apps/studio/src/cloud/styles/
 * tokens.css, `--c-pr-*`): open green, merged purple, failing red, running amber.
 */
const PR_COLOR = {
  light: {
    open: "#3f8a4a",
    failing: "#b4453a",
    running: "#d4a017",
    conflict: "#b7791f",
    merged: "#8250df",
  },
  dark: {
    open: "#5fb36b",
    failing: "#e0675b",
    running: "#e3b341",
    conflict: "#d99a3c",
    merged: "#a37ff0",
  },
} as const;

/** The foot button's mark, as the Mac's chrome's (apps/studio/src/cloud/window/next-action.tsx). */
const ACTION_ICON: Record<Exclude<NextAction, "create_pr" | "blocked">, IconSvgElement> = {
  ready: CheckmarkCircle01Icon,
  auto_merge: Clock01Icon,
  auto_merge_on: Clock01Icon,
  fix_checks: Wrench01Icon,
  resolve: Alert02Icon,
  update_branch: GitBranchIcon,
  merge: GitMergeIcon,
};

const CHECK_WORD: Record<CheckRun["state"], string> = {
  passing: "Passed",
  failing: "Failed",
  running: "Running",
  queued: "Queued",
  skipped: "Skipped",
};

/** What the sheet shows in its place: the pull request, or one of its drill-ins. */
type Drill =
  | { kind: "checks" }
  | { kind: "reviews" }
  | { kind: "conversation" }
  | { kind: "file"; path: string };

/** A GitHub address leaves the app: in Safari's sheet, or Mail for mailto. Nothing else opens. */
function openOutside(url: string) {
  const href = safeHref(url);
  if (!href) return;
  if (/^mailto:/i.test(href)) Linking.openURL(href).catch(() => {});
  else WebBrowser.openBrowserAsync(href).catch(() => {});
}

/** Asks before a merge: the system's action sheet, Merge or Cancel, and never a bypass (D13). */
function confirmMerge(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: question, options: [PR.actions.merge, PR.cancel], cancelButtonIndex: 1 },
      (index) => resolve(index === 0),
    );
  });
}

/**
 * The pull request sheet (iPhone design §11, board 3.10): the canvas's pull request as GitHub has
 * it, and its one next action at the foot. Opened by the stack's pull request button, a pull
 * request line in the chat, or a link or push (`sheet=pull-request`).
 *
 * The header: the state's mark, the number, Open on GitHub and Close. Then the title, `branch →
 * base`, the description (GitHub's Markdown, drawn as the chat draws Ponzu's, links leaving only
 * for the web), the Status card (checks, the reviews, the comments) and the files. Each row of
 * the card and each file opens a drill-in inside the sheet, with a glass Back: every check, the
 * reviews, the conversation (read-only: replying is GitHub's, or Claude's when asked in the
 * chat), or a file's diff.
 *
 * The foot is what the API says is next (lib/pull-request.ts): Ready, Auto-merge, Update branch
 * and Merge go to GitHub as the person; Fix checks and Resolve ask Claude in the chat. Merge
 * asks first. While one is on its way the label stays, the button dims and a spinner takes the
 * icon's place; one that didn't happen says GitHub's reason above it. Merged: no button, and the
 * mark goes purple. Held back by the repo's rules with no auto-merge: a line that it needs the
 * Mac. The pull request is read when the sheet opens and again whenever the canvas's head says
 * it moved.
 */
export function PrSheet({
  canvasId,
  head,
  viewerLogin,
  blocked,
  onDismiss,
  top,
  right,
  maxWidth,
  bottomBar,
}: {
  canvasId: string;
  head: CanvasHeadRow | undefined;
  /** The person's GitHub login: their own comments and reviews read "You". */
  viewerLogin: string | null;
  /** Why the person can't act on it now (read access, offline): in the button's place. */
  blocked: string | null;
  onDismiss: () => void;
  top: number;
  right?: number;
  maxWidth?: number;
  bottomBar?: number;
}) {
  const { color, scheme } = useTheme();
  const cloud = useCloud();
  const query = useQuery({
    ...cloud.queries.pullRequest(canvasId),
    enabled: cloud.userId !== null,
  });
  const tab = query.data ?? null;

  // Read again whenever the head says the pull request moved, or the agent's turn changed.
  const moved = head
    ? [head.prNumber, head.prState, head.prChecks, head.prMergeable, head.prAutoMerge].join(" ")
    : "";
  const turn = head?.agentState ?? "";
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void query.refetch();
  }, [moved, turn]);

  const actions = useMemo(
    () =>
      new PrActions({
        act: (action) =>
          new MutationObserver(cloud.queryClient, cloud.mutations.pullRequestAction()).mutate({
            canvasId,
            action,
          }),
        tell: async (text) => {
          await backend.api.canvases.sendMessage(canvasId, { text });
        },
        confirm: confirmMerge,
      }),
    [cloud, canvasId],
  );
  const acting = useSyncExternalStore(actions.subscribe, actions.getSnapshot);

  const [drill, setDrill] = useState<Drill | null>(null);
  const pull = tab?.pullRequest ?? null;
  const pr = useMemo(() => (pull ? toPullRequestDetail(pull) : null), [pull]);

  const run = (action: NextAction) => {
    if (!tab) return;
    tick();
    void actions.run(action, tab).then((came) => {
      if (came === "failed") fail();
      else if (came === "done") success();
    });
  };

  const iconState = pull
    ? pullRequestIcon({
        number: pull.number,
        state: pull.state,
        checks: pull.checks.state,
        mergeable: pull.mergeable,
        autoMerge: Boolean(pull.autoMerge),
      })
    : "open";
  const mark = {
    open: { icon: GitPullRequestIcon, tint: PR_COLOR[scheme].open },
    draft: { icon: GitPullRequestIcon, tint: color.faint },
    conflict: { icon: GitPullRequestClosedIcon, tint: PR_COLOR[scheme].conflict },
    merged: { icon: GitMergeIcon, tint: PR_COLOR[scheme].merged },
    closed: { icon: GitPullRequestClosedIcon, tint: color.muted },
  }[iconState];
  const number = pull?.number ?? head?.prNumber ?? null;
  const foot = prFoot(tab, { readOnly: blocked, asked: acting.asked });

  return (
    <Sheet
      testID="pr-sheet"
      onDismiss={onDismiss}
      top={top}
      gap={0}
      right={right}
      maxWidth={maxWidth}
      bottomBar={bottomBar}
    >
      {drill && pr ? (
        <DrillIn
          drill={drill}
          pr={pr}
          canvasId={canvasId}
          viewerLogin={viewerLogin}
          onBack={() => {
            tick();
            setDrill(null);
          }}
        />
      ) : (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 12 }}>
            <HugeiconsIcon icon={mark.icon} size={18} color={mark.tint} strokeWidth={1.8} />
            <Text
              testID="pr-number"
              style={{ fontFamily: font.mono, fontWeight: "500", fontSize: 15, color: color.ink }}
            >
              {number !== null ? `#${number}` : ""}
            </Text>
            <View style={{ flex: 1 }} />
            {pull && (
              <Round
                testID="pr-open-github"
                label={PR.mac.openOnGithub}
                onPress={() => {
                  tick();
                  openOutside(pull.url);
                }}
              >
                <HugeiconsIcon
                  icon={LinkSquare02Icon}
                  size={18}
                  color={color.ink}
                  strokeWidth={1.8}
                />
              </Round>
            )}
            <Round testID="pr-close" label={PR.close} onPress={onDismiss}>
              <HugeiconsIcon icon={Cancel01Icon} size={18} color={color.ink} strokeWidth={1.8} />
            </Round>
          </View>
          {pr ? (
            <ScrollView
              testID="pr-scroll"
              style={{ flex: 1, minHeight: 0 }}
              contentContainerStyle={{ paddingTop: 12, paddingBottom: 16, gap: 12 }}
            >
              <Details pr={pr} />
              <StatusCard pr={pr} viewerLogin={viewerLogin} onDrill={setDrill} />
              <FilesCard pr={pr} onDrill={setDrill} />
            </ScrollView>
          ) : (
            <Waiting
              loading={query.isPending && query.fetchStatus === "fetching"}
              paused={query.isPending && query.fetchStatus === "paused"}
              error={query.isError ? query.error : null}
              none={Boolean(tab && !tab.pullRequest)}
              onRetry={() => void query.refetch()}
            />
          )}
          <Foot foot={foot} number={number} busy={acting.busy} failed={acting.failed} onRun={run} />
        </>
      )}
    </Sheet>
  );
}

/** A 40pt glass circle in the sheet's header. */
function Round({
  testID,
  label,
  onPress,
  children,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
    >
      <Glass
        interactive
        style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
      >
        {children}
      </Glass>
    </Pressable>
  );
}

/** Before the pull request is in: loading, unreachable, or there is none. */
function Waiting({
  loading,
  paused,
  error,
  none,
  onRetry,
}: {
  loading: boolean;
  paused: boolean;
  error: unknown;
  none: boolean;
  onRetry: () => void;
}) {
  const { color } = useTheme();
  const quiet = {
    fontFamily: font.sans,
    fontSize: 15,
    lineHeight: 21,
    color: color.muted,
  } as const;
  if (none) {
    return (
      <View style={{ flex: 1, paddingTop: 24 }}>
        <Text testID="pr-none" style={quiet}>
          {PR.none}
        </Text>
      </View>
    );
  }
  if (error) {
    // The API's own words for a canvas with no repository; else GitHub couldn't be read.
    const said =
      error instanceof ApiError && error.status === 409 ? error.message : PR.mac.unreachable;
    return (
      <View
        style={{ flex: 1, paddingTop: 24, flexDirection: "row", gap: 10, alignItems: "baseline" }}
      >
        <Text testID="pr-error" style={quiet}>
          {said}
        </Text>
        <Pressable testID="pr-retry" accessibilityRole="button" hitSlop={8} onPress={onRetry}>
          <Text style={{ ...quiet, fontWeight: "600", color: color.ink }}>{PR.mac.retry}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View
      testID="pr-loading"
      accessible
      accessibilityLabel={paused ? CHAT.unreachable : PR.loading}
      style={{ flex: 1, paddingTop: 24, flexDirection: "row", gap: 10, alignItems: "center" }}
    >
      {loading || !paused ? <ActivityIndicator size="small" color={color.muted} /> : null}
      {paused ? <Text style={quiet}>{CHAT.unreachable}</Text> : null}
    </View>
  );
}

/** The title, `branch → base` (and what became of it), and the description. */
function Details({ pr }: { pr: PullRequestDetail }) {
  const { color } = useTheme();
  const ended =
    pr.state === "draft"
      ? PR.draft
      : pr.state === "merged"
        ? `${PR.merged}${pr.endedAt ? ` ${ago(pr.endedAt, Date.now(), "long")}` : ""}`
        : pr.state === "closed"
          ? PR.closed
          : null;
  const body = bodyForTab(pr.body);
  return (
    <View style={{ gap: 8 }}>
      <Text
        testID="pr-title"
        accessibilityRole="header"
        style={{
          fontFamily: font.sans,
          fontWeight: "600",
          fontSize: 20,
          lineHeight: 25,
          color: color.ink,
        }}
      >
        {pr.title}
      </Text>
      <View
        testID="pr-branch"
        style={{ flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" }}
      >
        <HugeiconsIcon icon={GitBranchIcon} size={13} color={color.muted} strokeWidth={1.7} />
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, fontFamily: font.mono, fontSize: 13, color: color.muted }}
        >
          {pr.head} → {pr.base}
        </Text>
        {ended ? (
          <Text style={{ fontFamily: font.sans, fontSize: 13, color: color.muted }}>· {ended}</Text>
        ) : null}
      </View>
      {body ? (
        <Markdown text={body} quiet={false} onOpenLink={openOutside} testID="pr-body" />
      ) : null}
    </View>
  );
}

/** A section's label over its card. */
function Label({ children, after }: { children: string; after?: ReactNode }) {
  const { color } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, paddingTop: 8 }}>
      <Text
        accessibilityRole="header"
        style={{ fontFamily: font.sans, fontWeight: "600", fontSize: 13, color: color.muted }}
      >
        {children}
      </Text>
      {after}
    </View>
  );
}

function Card({ children }: { children: ReactNode }) {
  const { color } = useTheme();
  return (
    <View style={{ backgroundColor: color.bg, borderRadius: 16, overflow: "hidden" }}>
      {children}
    </View>
  );
}

/** A card's row, pressed to drill in: what it shows, and a faint chevron. */
function Row({
  testID,
  label,
  onPress,
  children,
  last = false,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  children: ReactNode;
  last?: boolean;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        select();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 13,
        paddingHorizontal: 16,
        backgroundColor: pressed ? color.chip : "transparent",
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: color.hairline,
      })}
    >
      {children}
      <View style={{ transform: [{ rotate: "-90deg" }] }}>
        <Chevron size={13} color={color.faint} />
      </View>
    </Pressable>
  );
}

function CheckGlyph({ state, size = 16 }: { state: CheckRun["state"]; size?: number }) {
  const { color, scheme } = useTheme();
  const tone = PR_COLOR[scheme];
  switch (state) {
    case "passing":
      return <HugeiconsIcon icon={Tick02Icon} size={size} color={tone.open} strokeWidth={2.2} />;
    case "failing":
      return (
        <HugeiconsIcon icon={Cancel01Icon} size={size} color={tone.failing} strokeWidth={2.2} />
      );
    case "running":
      return (
        <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tone.running }} />
        </View>
      );
    case "queued":
      return (
        <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              borderWidth: 1.5,
              borderColor: color.faint,
            }}
          />
        </View>
      );
    case "skipped":
      return <HugeiconsIcon icon={MinusSignIcon} size={size} color={color.faint} strokeWidth={2} />;
  }
}

/** A reviewer's or commenter's initial on the chip, or the agent's mark. */
function Initial({ name }: { name: string }) {
  const { color } = useTheme();
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        backgroundColor: color.chip,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontFamily: font.sans, fontWeight: "600", fontSize: 10, color: color.ink }}>
        {(name.trim()[0] ?? "?").toUpperCase()}
      </Text>
    </View>
  );
}

const rowText = (ink: string) =>
  ({ flex: 1, fontFamily: font.sans, fontSize: 16, lineHeight: 20, color: ink }) as const;

/** Status: the checks, the reviews and the comments, each a row that opens its drill-in. */
function StatusCard({
  pr,
  viewerLogin,
  onDrill,
}: {
  pr: PullRequestDetail;
  viewerLogin: string | null;
  onDrill: (drill: Drill) => void;
}) {
  const { color } = useTheme();
  const checks = checksLine(pr.checks, pr.state);
  const reviews = reviewsLine(pr.reviews, viewerLogin);
  const comments = pr.comments.length;
  return (
    <View style={{ gap: 8 }}>
      <Label>{PR.status}</Label>
      <Card>
        <Row
          testID="pr-checks"
          label={checks.text}
          onPress={() => onDrill({ kind: "checks" })}
          last={!reviews && !comments}
        >
          <CheckGlyph state={checks.glyph} />
          <Text numberOfLines={1} style={rowText(color.ink)}>
            {checks.text}
          </Text>
        </Row>
        {reviews && (
          <Row
            testID="pr-reviews"
            label={reviews.text}
            onPress={() => onDrill({ kind: "reviews" })}
            last={!comments}
          >
            <Initial name={authorName(reviews.review.author, viewerLogin)} />
            <Text numberOfLines={1} style={rowText(color.ink)}>
              {reviews.text}
            </Text>
            <Text style={{ fontFamily: font.mono, fontSize: 13, color: color.faint }}>
              {ago(reviews.review.at, Date.now(), "compact")}
            </Text>
          </Row>
        )}
        {comments > 0 && (
          <Row
            testID="pr-comments"
            label={PR.commentCount(comments)}
            onPress={() => onDrill({ kind: "conversation" })}
            last
          >
            <HugeiconsIcon icon={Comment01Icon} size={16} color={color.muted} strokeWidth={1.8} />
            <Text numberOfLines={1} style={rowText(color.ink)}>
              {PR.commentCount(comments)}
            </Text>
          </Row>
        )}
      </Card>
    </View>
  );
}

/** The plus and minus counts, in mono, green and red. */
function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  const { scheme } = useTheme();
  const tone = PR_COLOR[scheme];
  const mono = { fontFamily: font.mono, fontSize: 13 } as const;
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      <Text style={{ ...mono, color: tone.open }}>+{additions}</Text>
      <Text style={{ ...mono, color: tone.failing }}>−{deletions}</Text>
    </View>
  );
}

/** "N files" and the whole diff's size, then a row for each file, which opens its diff. */
function FilesCard({ pr, onDrill }: { pr: PullRequestDetail; onDrill: (drill: Drill) => void }) {
  const { color } = useTheme();
  if (!pr.files.length) return null;
  return (
    <View style={{ gap: 8 }}>
      <Label after={<Counts additions={pr.additions} deletions={pr.deletions} />}>
        {PR.files(pr.filesTotal)}
      </Label>
      <Card>
        {pr.files.map((file, i) => (
          <Row
            key={file.path}
            testID="pr-file"
            label={file.path}
            onPress={() => onDrill({ kind: "file", path: file.path })}
            last={i === pr.files.length - 1}
          >
            <Text
              numberOfLines={1}
              ellipsizeMode="head"
              style={{ flex: 1, fontFamily: font.mono, fontSize: 13, color: color.ink }}
            >
              {file.path}
            </Text>
            <Counts additions={file.additions} deletions={file.deletions} />
          </Row>
        ))}
      </Card>
    </View>
  );
}

/** The one action, pinned at the foot; or the line in its place; with why the last didn't go. */
function Foot({
  foot,
  number,
  busy,
  failed,
  onRun,
}: {
  foot: ReturnType<typeof prFoot>;
  number: number | null;
  busy: NextAction | null;
  failed: string | null;
  onRun: (action: NextAction) => void;
}) {
  const { color } = useTheme();
  const quiet = {
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 18,
    color: color.muted,
    textAlign: "center",
  } as const;
  if (!foot) return null;
  if (foot.kind === "line") {
    return (
      <Text testID="pr-foot-line" style={{ ...quiet, paddingTop: 12 }}>
        {foot.text}
      </Text>
    );
  }
  const inFlight = busy !== null;
  const dim = inFlight || !foot.enabled;
  return (
    <View style={{ gap: 8, paddingTop: 12 }}>
      {failed ? (
        <Text testID="pr-failed" accessibilityLiveRegion="polite" style={quiet}>
          {failed}
        </Text>
      ) : foot.note ? (
        <Text testID="pr-note" style={quiet}>
          {foot.note}
        </Text>
      ) : null}
      <Pressable
        testID="pr-action"
        accessibilityRole="button"
        // Merge says which: "Merge #412", as VoiceOver reads it; the system's sheet then asks.
        accessibilityLabel={
          foot.action === "merge" && number !== null ? PR.mergeLabel(number) : foot.label
        }
        accessibilityState={{ disabled: dim, busy: inFlight }}
        disabled={dim}
        onPress={() => onRun(foot.action)}
        style={({ pressed }) => ({
          height: 54,
          borderRadius: 99,
          backgroundColor: color.ink,
          opacity: dim ? 0.5 : pressed ? 0.85 : 1,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        })}
      >
        {busy === foot.action ? (
          <ActivityIndicator testID="pr-action-busy" size="small" color={color.bg} />
        ) : (
          <HugeiconsIcon
            icon={ACTION_ICON[foot.action]}
            size={18}
            color={color.bg}
            strokeWidth={2}
          />
        )}
        <Text style={{ fontFamily: font.sans, fontWeight: "600", fontSize: 17, color: color.bg }}>
          {foot.label}
        </Text>
      </Pressable>
    </View>
  );
}

const DRILL_TITLE = {
  checks: PR.mac.checks,
  reviews: PR.mac.approvals,
  conversation: PR.mac.comments,
} as const;

/** A drill-in, pushed inside the sheet: a glass Back, its title, and what it lists. */
function DrillIn({
  drill,
  pr,
  canvasId,
  viewerLogin,
  onBack,
}: {
  drill: Drill;
  pr: PullRequestDetail;
  canvasId: string;
  viewerLogin: string | null;
  onBack: () => void;
}) {
  const { color } = useTheme();
  const title = drill.kind === "file" ? drill.path : DRILL_TITLE[drill.kind];
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 12 }}>
        <Round testID="pr-back" label={PR.back} onPress={onBack}>
          <Back size={18} color={color.ink} />
        </Round>
        <Text
          testID="pr-drill-title"
          accessibilityRole="header"
          numberOfLines={1}
          ellipsizeMode="head"
          style={{
            flex: 1,
            fontFamily: drill.kind === "file" ? font.mono : font.sans,
            fontWeight: "600",
            fontSize: drill.kind === "file" ? 14 : 17,
            color: color.ink,
          }}
        >
          {title}
        </Text>
      </View>
      <ScrollView
        testID={`pr-drill-${drill.kind}`}
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingTop: 14, paddingBottom: 24, gap: 12 }}
      >
        {drill.kind === "checks" && <Checks pr={pr} />}
        {drill.kind === "reviews" && <Reviews pr={pr} viewerLogin={viewerLogin} />}
        {drill.kind === "conversation" && <Conversation pr={pr} viewerLogin={viewerLogin} />}
        {drill.kind === "file" && (
          <FileDiff
            canvasId={canvasId}
            headSha={pr.headSha}
            file={pr.files.find((f) => f.path === drill.path) ?? null}
            url={pr.url}
          />
        )}
      </ScrollView>
    </>
  );
}

/** Every check, never folded: what failed first, then what is going, then what passed. */
function Checks({ pr }: { pr: PullRequestDetail }) {
  const { color } = useTheme();
  if (!pr.checks.length) {
    return (
      <Text style={{ fontFamily: font.sans, fontSize: 15, color: color.muted }}>
        {pr.state === "open" || pr.state === "draft" ? PR.mac.noChecks : PR.mac.noChecksRan}
      </Text>
    );
  }
  return (
    <>
      {orderChecks(pr.checks).map((check) => {
        const took =
          check.startedAt && check.completedAt
            ? duration(Date.parse(check.completedAt) - Date.parse(check.startedAt))
            : null;
        const meta = took ?? check.description ?? CHECK_WORD[check.state];
        return (
          <Pressable
            key={check.id}
            testID="pr-check"
            accessibilityRole={check.url ? "link" : "text"}
            accessibilityLabel={`${CHECK_WORD[check.state]}: ${check.name}`}
            disabled={!check.url}
            onPress={() => check.url && openOutside(check.url)}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32 }}
          >
            <CheckGlyph state={check.state} size={15} />
            <Text numberOfLines={1} style={rowText(color.ink)}>
              {check.name}
            </Text>
            <Text style={{ fontFamily: font.mono, fontSize: 13, color: color.faint }}>{meta}</Text>
          </Pressable>
        );
      })}
    </>
  );
}

function Reviews({ pr, viewerLogin }: { pr: PullRequestDetail; viewerLogin: string | null }) {
  const { color } = useTheme();
  return (
    <>
      {pr.reviews.map((review) => {
        const name = authorName(review.author, viewerLogin);
        return (
          <View
            key={review.id}
            testID="pr-review"
            style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32 }}
          >
            <Initial name={name} />
            <Text numberOfLines={1} style={rowText(color.ink)}>
              {name} {review.state === "approved" ? "approved" : "requested changes"}
            </Text>
            <Text style={{ fontFamily: font.mono, fontSize: 13, color: color.faint }}>
              {ago(review.at, Date.now(), "compact")}
            </Text>
          </View>
        );
      })}
    </>
  );
}

/** What people said on GitHub, oldest first. Read-only: there is no reply field anywhere. */
function Conversation({ pr, viewerLogin }: { pr: PullRequestDetail; viewerLogin: string | null }) {
  const { color } = useTheme();
  return (
    <>
      {pr.comments.map((comment: PrComment) => {
        const name = authorName(comment.author, viewerLogin);
        const where = comment.path
          ? `${comment.path.split("/").pop()}${comment.line ? `:${comment.line}` : ""}`
          : null;
        return (
          <View key={comment.id} testID="pr-comment" style={{ flexDirection: "row", gap: 10 }}>
            <Initial name={name} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={{ fontFamily: font.sans, fontSize: 13, color: color.faint }}>
                <Text style={{ fontWeight: "600", color: color.ink }}>{name}</Text>
                {where ? ` · ${where}` : ""} · {ago(comment.at, Date.now(), "compact")}
              </Text>
              <Markdown text={comment.body} onOpenLink={openOutside} />
            </View>
          </View>
        );
      })}
    </>
  );
}

/** A file's diff at the commit the sheet shows: read once for that commit. */
function FileDiff({
  canvasId,
  headSha,
  file,
  url,
}: {
  canvasId: string;
  headSha: string;
  file: PrFile | null;
  url: string;
}) {
  const { color } = useTheme();
  const cloud = useCloud();
  const path = file?.path ?? "";
  const read = useQuery({
    ...cloud.queries.pullRequestFile(canvasId, path, headSha),
    enabled: Boolean(file) && cloud.userId !== null,
  });
  if (!file) return null;
  const quiet = {
    fontFamily: font.sans,
    fontSize: 14,
    lineHeight: 20,
    color: color.muted,
  } as const;
  return (
    <View style={{ gap: 12 }}>
      {read.data?.previousPath ? (
        <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.faint }}>
          {read.data.previousPath} →
        </Text>
      ) : null}
      {read.data ? (
        <Diff diff={read.data.diff} />
      ) : read.isError ? (
        <Text testID="pr-diff-error" style={quiet}>
          {PR.mac.unreachable}
        </Text>
      ) : (
        <ActivityIndicator size="small" color={color.muted} />
      )}
      {read.data && read.data.diff.kind !== "text" ? (
        <Pressable accessibilityRole="link" onPress={() => openOutside(`${url}/files`)}>
          <Text style={{ ...quiet, fontWeight: "600", color: color.ink }}>
            {PR.mac.openOnGithub}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
