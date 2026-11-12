import { LiveProvider, useSessionState } from "@ponzu/client/react";
import { useEffect, useRef } from "react";
import { AppWindow } from "../cloud/window/app-window.tsx";
import { useAnalytics, useView } from "./analytics/provider.tsx";
import type { Host } from "./host.ts";
import { MainWindow } from "./main-window.tsx";
import { PonzuQueryProvider } from "./ponzu-query.tsx";
import { FirstRun } from "./setup/first-run.tsx";
import { SignInScreen } from "./sign-in.tsx";
import { UpdateMark, UpdateRequired } from "./update.tsx";
import { Welcome1x } from "./welcome-1x.tsx";

/*
 * The app's gates, in order (onboarding 3.2): no session, the sign-in screen; a build the API
 * refuses, the update; signed in, guided setup until every step of it is done (FirstRun), then
 * the main window, on live data. Signing out unmounts all of it, which lets go of every live
 * query and every cached answer it held.
 */
export function App({ host }: { host: Host }) {
  // The welcome from Ponzu 1.x sits beside every gate, so it stays up while the session changes
  // under it (over the sign-in screen, as it opens, and past a sign-in).
  return (
    <>
      <Gates host={host} />
      <Welcome1x host={host} />
    </>
  );
}

function Gates({ host }: { host: Host }) {
  const state = useSessionState(host.session);
  const badge = <UpdateMark updater={host.update} />;
  // Whether this window has shown the sign-in screen: then signing in waits on it, rather
  // than flashing to an empty window, until the first step can show.
  const askedToSignIn = useRef(false);
  // Who is using the window, for PostHog: the Ponzu user id, and nobody once they sign out.
  const analytics = useAnalytics();
  const userId = state.status === "signed_in" ? state.user.id : null;
  const signedOut = state.status === "signed_out" || state.status === "github_reauth";
  useEffect(() => {
    if (userId) analytics.identify(userId);
    else if (signedOut) analytics.signedOut();
  }, [analytics, userId, signedOut]);
  useView(state.status === "too_old" ? { name: "update" } : signedOut ? { name: "sign-in" } : null);

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
