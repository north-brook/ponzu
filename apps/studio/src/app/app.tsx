import { LiveProvider, useSessionState } from "@ponzu/client/react";
import { AppWindow } from "../cloud/window/app-window.tsx";
import type { Host } from "./host.ts";
import { MainWindow } from "./main-window.tsx";
import { SignInScreen } from "./sign-in.tsx";
import { UpdateMark, UpdateRequired } from "./update.tsx";

/*
 * The app's gates, in order (onboarding 3.2): no session, the sign-in screen; a build the API
 * refuses, the update; otherwise the main window, on live data. Signing out unmounts the main
 * window, which lets go of every live query it held.
 *
 * SEAM(guided setup): the setup track's gates (where you design, connecting Claude, the iPhone)
 * go between signing in and the main window. Until then the main window asks for what it
 * can't do without: a workspace (NoWorkspace in main-window.tsx).
 */
export function App({ host }: { host: Host }) {
  const state = useSessionState(host.session);
  const badge = <UpdateMark updater={host.update} />;

  if (state.status === "signed_in") {
    return (
      <LiveProvider live={host.live}>
        <MainWindow key={state.user.id} host={host} user={state.user} badge={badge} />
      </LiveProvider>
    );
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
