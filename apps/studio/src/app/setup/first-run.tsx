import type { Live } from "@ponzu/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ClaudeStep } from "../../cloud/setup/claude-step.tsx";
import { IphoneStep } from "../../cloud/setup/iphone-step.tsx";
import { setupStep } from "../../cloud/setup/setup.ts";
import { SignInStep } from "../../cloud/setup/sign-in.tsx";
import { AppWindow } from "../../cloud/window/app-window.tsx";
import type { SetupStepName } from "../analytics/events.ts";
import { useAnalytics, useView } from "../analytics/provider.tsx";
import type { Host } from "../host.ts";
import { shownWorkspace } from "../map.ts";
import { PaneMessage } from "../notices.tsx";
import { usePonzu } from "../ponzu-query.tsx";
import { hasIphone } from "../settings/map.ts";
import { loadUi, saveUi } from "../ui-state.ts";
import { useClaudeConnect } from "./claude-connect.ts";
import { setupFacts } from "./facts.ts";
import { useArrivalSync, WhereView } from "./where-view.tsx";

/*
 * Guided first run on the Mac (onboarding 3.2): after signing in, the gates are read from the
 * server (`GET /v1/me`) and the first one that holds the person back is the step shown: where
 * they design, connecting Claude, the iPhone. Each step's own action is what clears its gate,
 * so nothing can be skipped, and a step finished on another device is passed over here: the
 * live `me` row asks for `me` again. With every gate clear, the window is `children`.
 *
 * Between two steps the person sees the step they were on, its action pending, and then the
 * next one: never the sign-in screen, an empty window or an earlier step. So what a step waits
 * on is asked for before its gate opens (the devices, the defaults, the window's workspace,
 * alongside `me`), and while the step the gates name can't show yet, the one on screen stays. Only before any step has
 * shown does the window wait: on the sign-in screen just after signing in, and empty (the
 * shell's own quiet first paint) on a relaunch.
 */
type Shown = "where" | "claude" | "iphone";

export function FirstRun({
  host,
  userId,
  justSignedIn,
  badge,
  children,
}: {
  host: Host;
  userId: string;
  /** Signed in a moment ago: the sign-in screen waits on until the first step can show. */
  justSignedIn: boolean;
  badge: ReactNode;
  children: ReactNode;
}) {
  const { queries } = usePonzu();
  const me = useQuery(queries.me());
  // The iPhone step is for someone without Ponzu on their phone: their devices say. Asked with
  // `me`, so they are in hand when Claude connects; if they can't be had, the step shows.
  const devices = useQuery({ ...queries.notifications(), enabled: me.data !== undefined });
  const phone = devices.data ? hasIphone(devices.data) : false;
  const step = me.data ? setupStep(setupFacts(me.data, phone)) : null;
  // "Where do you design?" waits for its list: until then the sign-in screen keeps waiting.
  const arrival = useArrivalSync(step === "where");
  // Fresh start's model picker shows the person's defaults: asked for alongside `me`, so the
  // create page opens whole. If they can't be had it opens anyway, and the API applies them.
  const defaults = useQuery({ ...queries.claudeDefaults(), enabled: me.data !== undefined });
  // The window opens whole too: the workspace it will show, its repos and its designs are read
  // ahead from the moment there is one, as the window asks for them, so it finds them in hand
  // and the create page knows from its first frame whether ideas come (their room left, the
  // composer never moving).
  // Once the window is shown it stays: what it does next (another workspace) is its own.
  const handedOver = useRef(false);
  if (step !== "done") handedOver.current = false;
  const ahead =
    me.data && step !== "where" && !handedOver.current
      ? shownWorkspace(me.data.workspaces, loadUi(userId).workspaceId)
      : null;
  const detail = useQuery({ ...queries.workspace(ahead?.id ?? ""), enabled: ahead !== null });
  const designs = useDesignsAhead(host.live, ahead?.id ?? null);
  /** The step on screen, which stays while the next one can't show yet. */
  const shown = useRef<Shown | null>(null);

  const waiting =
    !me.data ||
    step === "done" ||
    (step === "where" && arrival.loading) ||
    // The iPhone step waits for the devices, so it never shows to someone who has one.
    (step === "iphone" && devices.isPending);
  useSetupSteps(
    waiting || step === null || step === "sign_in" || step === "done" ? null : step,
    step === "done",
    !me.data && me.isError,
  );

  const windowReady = !defaults.isPending && !(ahead && (detail.isPending || !designs));
  if (step === "done" && (handedOver.current || windowReady)) {
    handedOver.current = true;
    return children;
  }

  const view: Shown | null = waiting ? shown.current : (step as Shown | null);
  shown.current = view;
  let content: ReactNode = null;
  if (!me.data && me.isError) {
    content = (
      <PaneMessage
        title="Can't reach Ponzu"
        body="Check your connection. Your designs are safe in the cloud and open as soon as Ponzu is back."
        action={{ label: "Try again", onClick: () => void me.refetch() }}
        busy={me.isFetching}
      />
    );
  } else if (view === "where") {
    content = (
      <WhereView
        host={host}
        onWorkspaceSetUp={(workspaceId) => saveUi(userId, { ...loadUi(userId), workspaceId })}
      />
    );
  } else if (view === "claude") {
    content = <ClaudeView host={host} />;
  } else if (view === "iphone") {
    content = <IphoneView />;
  } else if (justSignedIn) {
    content = <SignInStep state="waiting" onContinue={() => {}} />;
  }
  return (
    <AppWindow lights={host.lights} sidebar={null} rail={null} badge={badge}>
      {content}
    </AppWindow>
  );
}

/**
 * Each step as it shows (`setup step reached`, and its view), and each one left for the next or
 * for the window (`setup step completed`): a step is only ever left by doing it.
 */
function useSetupSteps(shown: SetupStepName | null, done: boolean, unreachable: boolean) {
  const analytics = useAnalytics();
  useEffect(() => {
    if (unreachable) analytics.capture("notice shown", { notice: "cant_reach_ponzu" });
  }, [analytics, unreachable]);
  const last = useRef<SetupStepName | null>(null);
  useView(shown ? { name: "setup", step: shown } : null);
  useEffect(() => {
    const was = last.current;
    if (was && (done || (shown && shown !== was))) {
      analytics.capture("setup step completed", { step: was });
      last.current = null;
    }
    if (shown && shown !== was) {
      analytics.capture("setup step reached", { step: shown });
      last.current = shown;
    }
  }, [analytics, shown, done]);
}

/** Connect Claude: once the API has it, `me` says so and the gates move on. */
function ClaudeView({ host }: { host: Host }) {
  const card = useClaudeConnect({ openExternal: host.openExternal, leavesWhenConnected: true });
  return <ClaudeStep {...card} />;
}

/** The iPhone step: Start designing stays pending until the window it opens is there. */
function IphoneView() {
  const { mutations } = usePonzu();
  const seen = useMutation(mutations.recordOnboarding());
  return (
    <IphoneStep onStart={() => seen.mutate("iphone")} starting={seen.isPending || seen.isSuccess} />
  );
}

/** How long the window waits on its designs before it opens without them. */
const DESIGNS_AHEAD_MS = 3_000;

/**
 * Subscribes ahead to the designs of the workspace the window will open on, true once they
 * have answered (or failed, or `DESIGNS_AHEAD_MS` passed, so a slow Realtime never holds setup
 * up). The window's own subscription to the same query shares this one; letting go waits a
 * moment, so the rows are still there when the window subscribes in the commit after.
 */
function useDesignsAhead(live: Live, workspaceId: string | null): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (workspaceId === null) return;
    const args = { workspaceId };
    const settle = () => setSettled(workspaceId);
    const timer = setTimeout(settle, DESIGNS_AHEAD_MS);
    const off = live.subscribe("workspace.designs", args, (snapshot) => {
      if (snapshot.status !== "connecting") settle();
    });
    if (live.snapshot("workspace.designs", args).status !== "connecting") settle();
    return () => {
      clearTimeout(timer);
      setTimeout(off, DESIGNS_AHEAD_MS);
    };
  }, [live, workspaceId]);
  return workspaceId !== null && settled === workspaceId;
}
