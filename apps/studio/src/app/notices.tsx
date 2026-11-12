import type { ReactNode } from "react";
import { Button } from "../cloud/ui/button.tsx";
import { Slice } from "../cloud/ui/marks.tsx";

/*
 * The window's calm states. Something gone wrong is said in a sentence where the work would be,
 * with the one thing to do about it, never as a dialog or a crash: offline, access lost, a
 * canvas deleted while open.
 */

/** The main pane's whole content, when there is nothing to show but why. */
export function PaneMessage({
  title,
  body,
  action,
  busy = false,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
  /** Still trying: the slice turns grey. */
  busy?: boolean;
}) {
  return (
    <div
      role="status"
      className="absolute inset-0 flex flex-col items-center justify-center px-6 pb-10 text-center"
    >
      <Slice size={40} turning={busy} className={busy ? "text-dry" : "text-faint"} />
      <h2 className="m-0 mt-6 font-display font-semibold text-[22px] text-ink tracking-[-0.02em]">
        {title}
      </h2>
      <p className="m-0 mt-2 max-w-[400px] text-14 text-muted leading-[1.5]">{body}</p>
      {action ? (
        <Button variant="action" className="mt-5 h-8 px-3.5" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/** A line over the top of the main pane: the work stays where it is beneath it. */
export function Banner({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-6">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-2 rounded-pill bg-surface py-1.5 pr-1.5 pl-3.5 text-12 text-muted shadow-pop"
      >
        {children}
        {action ?? <span className="w-2" />}
      </div>
    </div>
  );
}
