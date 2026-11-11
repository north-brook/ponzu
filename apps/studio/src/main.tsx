import "./pz.css";
import "./app/app.css";
import { createRoot } from "react-dom/client";
import { App } from "./app/app.tsx";
import { CantStart } from "./app/cant-start.tsx";
import { desktopHost } from "./app/desktop-host.ts";
import type { Host } from "./app/host.ts";
import { quietPointerFocus } from "./cloud/ui/quiet-focus.ts";

/*
 * The studio's entry. Inside the Mac app the shell's bridge is there and the app runs on it. In
 * a plain browser it runs on Ponzu Cloud in memory, but only in development (`vite`) and the
 * headless test's build (`--mode e2e`): a shipped build doesn't carry it at all, so a bridge that
 * failed to load shows that, never a working-looking world that saves nothing.
 */
async function host(): Promise<Host | null> {
  if (window.ponzuDesktop) return desktopHost(window.ponzuDesktop);
  // The mode, not DEV: DEV follows NODE_ENV, which a test runner sets for the build too.
  if (import.meta.env.MODE === "development" || import.meta.env.MODE === "e2e") {
    const { fakeHost } = await import("./app/fake-host.ts");
    return fakeHost();
  }
  return null;
}

// A ring shows for the keyboard only, never after a click (ui/quiet-focus.ts).
quietPointerFocus();

void host().then((host) =>
  createRoot(document.getElementById("root")!).render(host ? <App host={host} /> : <CantStart />),
);
