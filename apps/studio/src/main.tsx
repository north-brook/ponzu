import "./pz.css";
import "./app/app.css";
import { createRoot } from "react-dom/client";
import { App } from "./app/app.tsx";
import { desktopHost } from "./app/desktop-host.ts";
import type { Host } from "./app/host.ts";

/*
 * The studio's entry. Inside the Mac app the shell's bridge is there and the app runs on it; in
 * a plain browser (development, the headless test) it runs on Ponzu Cloud in memory, which is
 * loaded only then.
 */
async function host(): Promise<Host> {
  if (window.ponzuDesktop) return desktopHost(window.ponzuDesktop);
  const { fakeHost } = await import("./app/fake-host.ts");
  return fakeHost();
}

void host().then((host) =>
  createRoot(document.getElementById("root")!).render(<App host={host} />),
);
