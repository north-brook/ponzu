import { useEffect, useState } from "react";
import { Welcome1xSheet } from "../cloud/dialogs/welcome-1x.tsx";
import type { Host } from "./host.ts";

/**
 * Whether the shell says this is the launch to show the welcome: only a plain `true` does. No
 * shell to ask (a browser, the gallery, the tests), an answer of any other shape, or a failed
 * ask all mean no.
 */
export async function shouldWelcome1x(host: Pick<Host, "welcome1x">): Promise<boolean> {
  try {
    return (await host.welcome1x?.()) === true;
  } catch {
    return false;
  }
}

/**
 * The welcome from Ponzu 1.x, when the shell says this is the launch to show it (`welcome1x`,
 * which answers true once, ever, and only on a computer 1.x was on).
 */
export function Welcome1x({ host }: { host: Pick<Host, "welcome1x"> }) {
  const [open, setOpen] = useState(false);
  // The shell answers true once, so nothing here may drop that answer: no cancelling on cleanup.
  useEffect(() => {
    void shouldWelcome1x(host).then((show) => {
      if (show) setOpen(true);
    });
  }, [host]);
  return <Welcome1xSheet open={open} onContinue={() => setOpen(false)} />;
}
