import { LiveProvider, useSessionState } from "@ponzu/client/react";
import { useRef } from "react";
import { AppWindow } from "../cloud/window/app-window.tsx";
import type { Host } from "./host.ts";
import { MainWindow } from "./main-window.tsx";
import { PonzuQueryProvider } from "./ponzu-query.tsx";
import { FirstRun } from "./setup/first-run.tsx";
import { SignInScreen } from "./sign-in.tsx";
import { UpdateMark, UpdateRequired } from "./update.tsx";

/*
 * The app's gates, in order (onboarding 3.2): no session, the sign-in screen; a build the API
 * refuses, the update; signed in, guided setup until every step of it is done (FirstRun), then
 * the main window, on live data. Signing out unmounts all of it, which lets go of every live
 * query and every cached answer it held.
 */
export function App({ host }: { host: Host }) {
  const state = useSessionState(host.session);
  const badge = <UpdateMark updater={host.update} />;
  // Whether this window has shown the sign-in screen: then signing in waits on it, rather
  // than flashing to an empty window, until the first step can show.
  const askedToSignIn = useRef(false);

  if (state.status === "signed_in") {
    return (
      <LiveProvider live={host.live}>
        <PonzuQueryProvider key={state.user.id} host={host}>
          <FirstRun
            host={host}
            userId={state.user.id}
            justSignedIn={askedToSignIn.current}
            badge={badge}
          >
            <MainWindow key={state.user.id} host={host} user={state.user} badge={badge} />
          </FirstRun>
        </PonzuQueryProvider>
      </LiveProvider>
    );
  }
  if (state.status === "signed_out" || state.status === "github_reauth") {
    askedToSignIn.current = true;
  }
  return (
    <AppWindow lights={host.lights} sidebar={null} rail={null} badge={badge}>
      {state.status === "too_old" ? (
        <UpdateRequired updater={host.update} />
      ) : state.status === "loading" ? null : (
        <SignInScreen host={host} reason={state.status} />
      )}
    </AppWindow>
  );
}
