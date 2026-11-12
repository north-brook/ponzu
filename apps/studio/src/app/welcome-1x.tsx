import { useEffect, useState } from "react";
import { Welcome1xSheet } from "../cloud/dialogs/welcome-1x.tsx";
import type { Host } from "./host.ts";

/**
 * The welcome from Ponzu 1.x, when the shell says this is the launch to show it (`welcome1x`,
 * which answers true once, ever, and only on a computer 1.x was on). A browser, the gallery and
 * the tests have no shell to ask, so they never show it.
 */
export function Welcome1x({ host }: { host: Pick<Host, "welcome1x"> }) {
  const [open, setOpen] = useState(false);
  // The shell answers true once, so nothing here may drop that answer: no cancelling on cleanup.
  useEffect(() => {
    host
      .welcome1x?.()
      .then((show) => {
        if (show) setOpen(true);
      })
      .catch(() => {});
  }, [host]);
  return <Welcome1xSheet open={open} onContinue={() => setOpen(false)} />;
}
