import type { ReactNode } from "react";
import { HandoffPage, handoffBody, handoffCta, handoffTitle } from "./handoff-page";

/*
 * Where a Ponzu 1 link that is out in the wild lands now that its page has retired (/local, /gh):
 * the handoff's page with no link to hand, a sentence on what the link was, and one way on. Not
 * for search engines; each page sets noindex.
 */
export function RetiredLanding({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: { href: string; label: string; icon: ReactNode };
}) {
  return (
    <HandoffPage>
      <div className="flex flex-col items-center gap-8 text-center animate-swap">
        <div className="flex flex-col items-center gap-3.5">
          <h1 className={handoffTitle}>{title}</h1>
          <p className={handoffBody}>{body}</p>
        </div>
        <a className={handoffCta} href={action.href}>
          {action.icon}
          {action.label}
        </a>
      </div>
    </HandoffPage>
  );
}
