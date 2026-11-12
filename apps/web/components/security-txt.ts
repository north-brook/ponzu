import { REPO } from "./links";
import { CONTACT } from "./site";

/*
 * The site's security.txt (RFC 9116): where to report a vulnerability. Served at /security.txt
 * (app/security.txt/route.ts) and at /.well-known/security.txt, the address the RFC names, by a
 * rewrite in next.config.ts.
 */

/** How long a served file says it holds: the RFC asks for less than a year. */
export const EXPIRES_DAYS = 180;

/** GitHub's private vulnerability reporting for the repository (the founder turns it on). */
export const ADVISORIES = `${REPO}/security/advisories/new`;

export function securityTxt(now: Date): string {
  const expires = new Date(now.getTime() + EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  return [
    `Contact: mailto:${CONTACT.security}`,
    `Contact: ${ADVISORIES}`,
    `Expires: ${expires.toISOString()}`,
    "Policy: https://ponzu.design/security",
    "Preferred-Languages: en",
    "Canonical: https://ponzu.design/.well-known/security.txt",
    "",
  ].join("\n");
}
