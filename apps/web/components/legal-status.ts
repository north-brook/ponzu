import type { Metadata } from "next";
import { ENTITY, LEGAL_EFFECTIVE, LEGAL_STATUS } from "./site";

/*
 * What LEGAL_STATUS (site.ts) means for the legal pages, as plain values the layout, the sitemap
 * and the tests all read. While it is "draft": every page under app/(legal) is kept out of search
 * and out of the sitemap, and says it is a draft. Flipping it to "in-effect" (with
 * LEGAL_EFFECTIVE) is the one change that publishes them.
 */

/** The pages under app/(legal), as people reach them. */
export const LEGAL_PAGES = ["/privacy", "/terms", "/subprocessors", "/security"] as const;

export const LEGAL_DRAFT = LEGAL_STATUS === "draft";

/** The legal layout's robots: noindex while a draft, the site's default once in effect. */
export function legalRobots(status: typeof LEGAL_STATUS = LEGAL_STATUS): Metadata["robots"] {
  return status === "draft" ? { index: false, follow: true } : undefined;
}

/** The draft notice's words, before its link to the Ponzu 1 policy. */
export const DRAFT_NOTICE = `Draft for review by ${ENTITY.name} and counsel. Not in effect.`;

/** Where the policy in effect for Ponzu 1 lives. */
export const PONZU_1_POLICY = "/privacy/ponzu-1";

/** The line every legal page ends on. */
export function lastUpdated(effective: string | null = LEGAL_EFFECTIVE): string {
  return `Last updated ${effective ?? "not yet in effect"}.`;
}
