import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sitemap from "./app/sitemap.ts";
import { DraftNotice, LastUpdated } from "./components/draft-notice.tsx";
import { SubprocessorSummary, SubprocessorTable } from "./components/legal.tsx";
import {
  LEGAL_DRAFT,
  LEGAL_PAGES,
  lastUpdated,
  legalRobots,
  PONZU_1_POLICY,
} from "./components/legal-status.ts";
import { ADVISORIES, EXPIRES_DAYS, securityTxt } from "./components/security-txt.ts";
import { CONTACT, ENTITY, LEGAL_EFFECTIVE, LEGAL_STATUS } from "./components/site.ts";
import { SUBPROCESSORS } from "./components/subprocessors.ts";
import config from "./next.config.ts";

/*
 * The legal pages (app/(legal)): drafts behind LEGAL_STATUS, the subprocessor list as data, the
 * Ponzu 1 policy kept, and security.txt. The pages are MDX, which bun cannot import, so their
 * source is read as text and the components they use are rendered here.
 */

const GROUP = join(import.meta.dir, "app", "(legal)");
const source = (page: string) => readFileSync(join(GROUP, page, "page.mdx"), "utf8");
const pages = readdirSync(GROUP, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

test("the legal group holds exactly the legal pages, each an MDX page with its own title", () => {
  expect(pages.map((p) => `/${p}`).sort()).toEqual([...LEGAL_PAGES].sort());
  for (const page of pages) {
    const text = source(page);
    expect(text).toMatch(/^export const metadata = \{\n {2}title: "[^"]+",/m);
    // Its canonical address is its own.
    expect(text).toContain(`path: "/${page}"`);
    // One title at the top of the column.
    expect(text.match(/^# /gm)).toHaveLength(1);
  }
});

test("while LEGAL_STATUS is draft, every legal page is noindex, shows the notice, and is not in the sitemap", () => {
  const layout = readFileSync(join(GROUP, "layout.tsx"), "utf8");
  // Every page in the group is under this layout, which sets robots from LEGAL_STATUS and draws
  // the notice and the last line around the page.
  expect(layout).toContain("export const metadata: Metadata = { robots: legalRobots() };");
  expect(layout).toMatch(/<DraftNotice \/>\s*\{children\}\s*<LastUpdated \/>/);
  expect(legalRobots("draft")).toEqual({ index: false, follow: true });
  expect(legalRobots("in-effect")).toBeUndefined();

  const notice = renderToStaticMarkup(createElement(DraftNotice, { draft: true }));
  expect(notice).toContain(`Draft for review by ${ENTITY.name} and counsel. Not in effect.`);
  expect(notice).toContain(`The policy in effect for Ponzu 1 is <a`);
  expect(notice).toContain(`href="${PONZU_1_POLICY}"`);
  expect(renderToStaticMarkup(createElement(DraftNotice, { draft: false }))).toBe("");

  const listed = sitemap().map((e) => new URL(e.url).pathname);
  for (const page of LEGAL_PAGES) expect(listed.includes(page)).toBe(!LEGAL_DRAFT);
  expect(LEGAL_DRAFT).toBe(LEGAL_STATUS === "draft");
  // The Ponzu 1 policy is the one in effect, so it is listed whatever the drafts are.
  expect(listed).toContain(PONZU_1_POLICY);
});

test("each page ends on its effective date, or says it is not in effect yet", () => {
  expect(lastUpdated(null)).toBe("Last updated not yet in effect.");
  expect(lastUpdated("December 1, 2026")).toBe("Last updated December 1, 2026.");
  expect(renderToStaticMarkup(createElement(LastUpdated, { effective: null }))).toContain(
    "Last updated not yet in effect.",
  );
});

test("once in effect, the pages carry a date and no open question", () => {
  // Today a guard for the future: flipping LEGAL_STATUS fails here until every <Open> is gone.
  const open = pages.filter((page) => source(page).includes("<Open"));
  if (LEGAL_DRAFT) {
    expect(open.length).toBeGreaterThan(0);
    return;
  }
  expect(LEGAL_EFFECTIVE).not.toBeNull();
  expect(open).toEqual([]);
  expect(SUBPROCESSORS.filter((row) => row.confirm)).toEqual([]);
});

test("the subprocessor list is one array, drawn whole on both pages", () => {
  expect(source("subprocessors")).toContain("<SubprocessorTable />");
  expect(source("privacy")).toContain("<SubprocessorSummary />");
  const table = renderToStaticMarkup(createElement(SubprocessorTable));
  const summary = renderToStaticMarkup(createElement(SubprocessorSummary));
  const rows = (html: string) =>
    [...html.matchAll(/data-subprocessor="([^"]+)"/g)].map((m) => m[1]);
  const names = SUBPROCESSORS.map((row) => row.name.replace(/&/g, "&amp;"));
  expect(rows(table)).toEqual(names);
  expect(rows(summary)).toEqual(names);
  for (const row of SUBPROCESSORS) expect(table).toContain(row.purpose.replace(/'/g, "&#x27;"));
});

test("the subprocessors the program settles are listed with their status", () => {
  const status = (name: string, purpose: RegExp) =>
    SUBPROCESSORS.find((row) => row.name.includes(name) && purpose.test(row.purpose))?.status;
  expect(status("Expo", /updates/)).toBe("in-use");
  expect(status("Expo", /pings/)).toBe("when-it-ships");
  expect(status("Stripe", /Payments/)).toBe("when-it-ships");
  for (const vendor of ["Vercel", "Neon", "Cloudflare", "WorkOS", "PostHog", "Anthropic"])
    expect(SUBPROCESSORS.find((row) => row.name.includes(vendor))?.status).toBe("in-use");
});

test("the privacy draft claims nothing the code does not do yet", () => {
  // Outside an <Open>, so a note to the founder may name what is not true yet.
  const text = source("privacy").replace(/<Open[^>]*>[\s\S]*?<\/Open>/g, "");
  // R2_PRIVATE_BUCKET is unset on dev: checkpoints are not in a private bucket.
  expect(text).not.toMatch(/private bucket/i);
  expect(text).not.toMatch(/checkpoints are private/i);
  // Whether Vercel keeps a command's env is asked in writing, not known.
  expect(text).not.toMatch(/Vercel (keeps|stores|records) no/i);
  expect(text).toContain("we have asked Vercel in writing");
  // Nothing sends pings yet (docs/cloud.md "Notifications").
  expect(text).toContain("Pings are not sent yet");
  // Deleting a canvas does not purge its files yet, nor does deleting an account reach GitHub or
  // PostHog: those are said only inside an <Open>.
  expect(text).not.toMatch(/revoke Ponzu's authorization/i);
  expect(text).not.toMatch(/ask PostHog to delete/i);
  // The settings switch is S10's; until it ships the draft must not send people to it.
  expect(text).not.toMatch(/Share usage data/);
  // Account deletion does rename the person's ops in a canvas's history (anonymiseUser); only a
  // comment author's name inside the document and its checkpoints stays.
  expect(text).not.toMatch(/name inside a canvas's history/i);
  // The download pages keep a session-storage note too (app/download/download.tsx), so the crash
  // marker is not the only thing the site keeps in the browser.
  expect(text).not.toMatch(/one thing the site keeps/i);
  expect(text).toContain("a note that the download has started");
  // The retention sweep (packages/db/src/queries/retention.ts) is built, at these periods.
  expect(text).toContain("Records of sign-in attempts are deleted a day after they expire.");
  expect(text).toMatch(/deleted 30 days after the work finished/);
  // The 1.x CLI is gone from this branch, and with it `ponzu telemetry off`.
  expect(text).not.toContain("ponzu telemetry off");
  // The anchor the app's settings will link to.
  expect(source("privacy")).toContain('<H2 id="analytics">');
});

test("no legal page states a price", () => {
  // Prices live in packages/db/src/rate-card.ts and the pricing page, never in legal copy.
  for (const page of pages) expect([page, source(page).match(/\$\d/)]).toEqual([page, null]);
});

test("the Ponzu 1 policy is kept at its own address", () => {
  const file = join(import.meta.dir, "app", "privacy", "ponzu-1", "page.tsx");
  expect(existsSync(file)).toBe(true);
  const text = readFileSync(file, "utf8");
  expect(text).toContain("For Ponzu 1, the local app and CLI");
  expect(text).toContain('path: "/privacy/ponzu-1"');
  // Moved word for word: its body still opens and closes as it did.
  expect(text).toContain(
    "Ponzu runs on your machine and has no accounts. Your designs stay with you.",
  );
  expect(text).toContain("Last updated October 27, 2026.");
});

test("security.txt has every field RFC 9116 asks for, and expires in the future", () => {
  const now = new Date("2026-11-12T00:00:00Z");
  const lines = securityTxt(now).trimEnd().split("\n");
  expect(lines).toEqual([
    `Contact: mailto:${CONTACT.security}`,
    `Contact: ${ADVISORIES}`,
    `Expires: ${new Date(now.getTime() + EXPIRES_DAYS * 86_400_000).toISOString()}`,
    "Policy: https://ponzu.design/security",
    "Preferred-Languages: en",
    "Canonical: https://ponzu.design/.well-known/security.txt",
  ]);
  expect(ADVISORIES).toBe("https://github.com/north-brook/ponzu/security/advisories/new");
  const expires = new Date(lines[2]!.slice("Expires: ".length));
  expect(expires.getTime()).toBeGreaterThan(now.getTime());
  // The RFC: "less than a year into the future".
  expect(expires.getTime() - now.getTime()).toBeLessThan(365 * 86_400_000);
});

test("security.txt is served at both addresses", async () => {
  const route = join(import.meta.dir, "app", "security.txt", "route.ts");
  expect(readFileSync(route, "utf8")).toContain("export const revalidate = 86400;");
  const rewrites = await config.rewrites!();
  const list = Array.isArray(rewrites)
    ? rewrites
    : [...(rewrites.beforeFiles ?? []), ...(rewrites.afterFiles ?? [])];
  expect(list).toContainEqual({
    source: "/.well-known/security.txt",
    destination: "/security.txt",
  });
  const { GET } = await import("./app/security.txt/route.ts");
  const response = GET();
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await response.text()).toStartWith(`Contact: mailto:${CONTACT.security}\n`);
});
