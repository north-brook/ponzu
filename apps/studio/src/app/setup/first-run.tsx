import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ClaudeStep } from "../../cloud/setup/claude-step.tsx";
import { IphoneStep } from "../../cloud/setup/iphone-step.tsx";
import { setupStep } from "../../cloud/setup/setup.ts";
import { SignInStep } from "../../cloud/setup/sign-in.tsx";
import { AppWindow } from "../../cloud/window/app-window.tsx";
import type { Host } from "../host.ts";
import { PaneMessage } from "../notices.tsx";
import { usePonzu } from "../ponzu-query.tsx";
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
 */
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
  const step = me.data ? setupStep(setupFacts(me.data)) : null;
  // "Where do you design?" waits for its list: until then the sign-in screen keeps waiting.
  const arrival = useArrivalSync(step === "where");
  // Fresh start's model picker shows the person's defaults: asked for alongside `me`, so the
  // create page opens whole. If they can't be had it opens anyway, and the API applies them.
  const defaults = useQuery({ ...queries.claudeDefaults(), enabled: me.data !== undefined });

  if (step === "done" && !defaults.isPending) return children;

  const waiting = !me.data || step === "done" || (step === "where" && arrival.loading);
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
  } else if (waiting) {
    content = justSignedIn ? <SignInStep state="waiting" onContinue={() => {}} /> : null;
  } else if (step === "where") {
    content = (
      <WhereView
        host={host}
        onWorkspaceSetUp={(workspaceId) => saveUi(userId, { ...loadUi(userId), workspaceId })}
      />
    );
  } else if (step === "claude") {
    content = <ClaudeView host={host} />;
  } else if (step === "iphone") {
    content = <IphoneView />;
  }
  return (
    <AppWindow lights={host.lights} sidebar={null} rail={null} badge={badge}>
      {content}
    </AppWindow>
  );
}

/** Connect Claude: once the API has it, `me` says so and the gates move on. */
function ClaudeView({ host }: { host: Host }) {
  return <ClaudeStep {...useClaudeConnect({ openExternal: host.openExternal })} />;
}

function IphoneView() {
  const { mutations } = usePonzu();
  const seen = useMutation(mutations.recordOnboarding());
  return <IphoneStep onStart={() => seen.mutate("iphone")} starting={seen.isPending} />;
}
