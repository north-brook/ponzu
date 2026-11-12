import { DRAFT_NOTICE, LEGAL_DRAFT, lastUpdated, PONZU_1_POLICY } from "./legal-status";
import { Link } from "./prose";

/**
 * The band at the top of every legal page while LEGAL_STATUS is "draft": what it is, that it is
 * not in effect, and where the policy that is in effect lives. Nothing once the pages are in
 * effect.
 */
export function DraftNotice({ draft = LEGAL_DRAFT }: { draft?: boolean }) {
  if (!draft) return null;
  return (
    <aside
      className="m-0 rounded-lg border border-rule bg-chip px-4 py-3 text-[15px]/6 text-ink"
      data-draft-notice
    >
      {DRAFT_NOTICE} The policy in effect for Ponzu 1 is <Link href={PONZU_1_POLICY}>here</Link>.
    </aside>
  );
}

/** The line every legal page ends on: its effective date, or that it is not in effect yet. */
export function LastUpdated({ effective }: { effective?: string | null }) {
  return (
    <p className="m-0 mt-8 text-[13px]/[19px] text-faint">
      {effective === undefined ? lastUpdated() : lastUpdated(effective)}
    </p>
  );
}
