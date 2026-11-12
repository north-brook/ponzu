import type { ReactNode } from "react";
import { Lockup } from "./icons";

/*
 * The handoff's page: the lockup alone at the top and one message in the middle. The canvas link
 * page (app/canvases/[id]) hands a canvas to the app in it, and the retired 1.x links (/local,
 * /gh) land in it with no link to hand. Plain, so server pages and the client handoff
 * (open-in-app.tsx) share it; a "use client" module's string exports would reach a server page as
 * references, not strings.
 */

export function HandoffPage({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[1440px] flex-col px-16 max-[720px]:px-5">
      <div className="flex h-[82px] items-center">
        <Lockup size={23} />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center pb-[82px]">{children}</main>
    </div>
  );
}

/** A message the page leads with, and the button under it. */
export const handoffTitle =
  "m-0 text-[clamp(32px,4.4vw,44px)] leading-[1.09] font-semibold tracking-[-0.035em] text-balance text-ink";
export const handoffBody = "m-0 max-w-[480px] text-[17px]/[27px] text-balance text-muted";
export const handoffCta =
  "inline-flex items-center gap-[9px] rounded-full bg-cta py-[15px] pr-6 pl-5 text-base font-semibold whitespace-nowrap text-cta-ink transition-[translate] duration-150 ease-out hover:-translate-y-px";
