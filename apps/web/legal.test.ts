import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sitemap from "./app/sitemap.ts";
import { DraftNotice, LastUpdated } from "./components/draft-notice.tsx";
import { Li, Open, SubprocessorSummary, SubprocessorTable } from "./components/legal.tsx";
import {
  LEGAL_DRAFT,
  LEGAL_PAGES,
  lastUpdated,
  legalRobots,
  PONZU_1_POLICY,
} from "./components/legal-status.ts";
import { ADVISORIES, EXPIRES_DAYS, securityTxt } from "./components/security-txt.ts";
import {
  CONTACT,
  ENTITY,
  GITHUB_PRIVATE_REPORTING,
  LEGAL_EFFECTIVE,
  LEGAL_STATUS,
} from "./components/site.ts";
import { SUBPROCESSORS } from "./components/subprocessors.ts";
import { components as mdxComponents } from "./mdx-components.tsx";
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

test("while a draft, the founder's and counsel's open notes stay in the source but are not drawn", () => {
  const note = (draft: boolean) =>
    renderToStaticMarkup(createElement(Open, { who: "founder", draft }, "a question"));
  expect(note(true)).toBe("");
  expect(note(false)).toContain("[For the founder: a question]");
  // The default follows LEGAL_STATUS, so the table draws no confirm note while a draft.
  if (LEGAL_DRAFT) {
    expect(renderToStaticMarkup(createElement(Open, { who: "counsel" }, "x"))).toBe("");
    expect(renderToStaticMarkup(createElement(SubprocessorTable))).not.toContain("data-open");
  }
  // A list item that is only a note (privacy's "- <Open>…</Open>" lines) would be an empty bullet,
  // so it goes while the note is hidden. MDX hands the item its children as below.
  const item = (draft: boolean, ...lead: string[]) =>
    renderToStaticMarkup(
      createElement(Li, null, ...lead, createElement(Open, { who: "founder", draft }, "q"), "\n"),
    );
  expect(item(true, "\n")).toBe("");
  expect(item(false, "\n")).toContain("<li>");
  expect(item(true, "Export: none. ")).toBe("<li>Export: none. \n</li>");
  expect(mdxComponents.li).toBe(Li);
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

test("once in effect, the terms name the state whose law governs them", () => {
  // The terms' governing law and venue read ENTITY.state; without it they can only say "the
  // state in which Northbrook PBC is incorporated". This is the one fact still to come before
  // the pages are in effect: set ENTITY.state in components/site.ts to the state of
  // incorporation, as the founder gives it.
  const terms = source("terms");
  expect(terms).toContain("governed by the laws of {STATE}");
  expect(terms).toContain("courts in {STATE}");
  expect(terms).toContain("export const STATE = ENTITY.state\n  ? `the State of $");
  if (LEGAL_DRAFT) return;
  if (ENTITY.state === null) {
    throw new Error(
      `The terms are in effect (LEGAL_STATUS) but ENTITY.state in components/site.ts is null: set it to ${ENTITY.name}'s state of incorporation, which the terms' governing law names.`,
    );
  }
  expect(ENTITY.state.trim()).not.toBe("");
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

test("the privacy policy claims nothing production does not do", () => {
  // Outside an <Open>, so a note to the founder may name what is not true yet.
  const text = source("privacy").replace(/<Open[^>]*>[\s\S]*?<\/Open>/g, "");
  // Production sets R2_PRIVATE_BUCKET: checkpoints are in a bucket of their own, not served.
  expect(text).toContain("Checkpoints are kept in a storage bucket of their own");
  // Whether Vercel keeps a command's env is not documented, and nothing says it was answered.
  expect(text).not.toMatch(/Vercel (keeps|stores|records) no/i);
  expect(text).toContain("Vercel does not document whether it keeps a record");
  // Nothing sends pushes or email yet, and the iPhone app does not register for them
  // (docs/cloud.md "Notifications"; apps/mobile has no push registration).
  expect(text).toContain("nothing is sent to phones or by email yet");
  // Deleting an account revokes the GitHub grant (apps/api/src/account/delete.ts). Production
  // has no PONZU_POSTHOG_PERSONAL_API_KEY, so forget.ts skips PostHog: the page must not say it
  // happens by itself, and says to write to us instead.
  expect(text).toContain("We also revoke Ponzu's authorization on your GitHub account.");
  expect(text).not.toContain("We ask PostHog to delete your profile, events and recordings");
  expect(text).toContain("does not yet delete what PostHog holds about you by itself");
  // PONZU_POSTHOG_AI_CONTENT is unset on production: model calls go without their content.
  expect(text).toContain("Never the prompts, the replies");
  // The production PostHog project keeps IP addresses ("Discard client IP data" is off).
  expect(text).toContain("Our PostHog project does not discard it.");
  // Ponzu for iPhone 1.0.0 sends nothing (apps/mobile/lib/telemetry.ts, canTrack = false).
  expect(text).toContain("Ponzu for iPhone** sends nothing to PostHog in this version");
  // The settings switch is built (users.share_usage, apps/api/src/analytics/analytics.ts's
  // withoutOptedOut, the runner's trace flag), and says what it stops, and what it does not.
  expect(text).toContain("turn off Settings › Account › Share usage data in the desktop app");
  expect(text).toContain("the agent's turns that you start are not traced");
  expect(text).toContain(
    "a turn that was already running when you turned it off may still be traced",
  );
  expect(text).toContain("Turning the switch off does not delete what was already sent");
  // Account deletion does rename the person's ops in a canvas's history (anonymiseUser); only a
  // comment author's name inside the document and its checkpoints stays.
  expect(text).not.toMatch(/name inside a canvas's history/i);
  // The download pages keep a session-storage note too (app/download/download.tsx), so the crash
  // marker is not the only thing the site keeps in the browser.
  expect(text).not.toMatch(/one thing the site keeps/i);
  expect(text).toContain("a note that the download has started");
  // The retention sweep (packages/db/src/queries/retention.ts) is built, at these periods.
  expect(text).toContain(
    "The short-lived records we keep while you connect Claude or install Ponzu's GitHub App are deleted a day after they expire.",
  );
  // auth_states holds only Claude sign-ins and GitHub App installs, not sign-ins to Ponzu.
  expect(text).not.toMatch(/records of sign-in attempts/i);
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
  const rest = [
    `Expires: ${new Date(now.getTime() + EXPIRES_DAYS * 86_400_000).toISOString()}`,
    "Policy: https://ponzu.design/security",
    "Preferred-Languages: en",
    "Canonical: https://ponzu.design/.well-known/security.txt",
  ];
  // GitHub's private reporting is listed only once it is on for the repository.
  expect(securityTxt(now, true).trimEnd().split("\n")).toEqual([
    `Contact: mailto:${CONTACT.security}`,
    `Contact: ${ADVISORIES}`,
    ...rest,
  ]);
  expect(securityTxt(now, false).trimEnd().split("\n")).toEqual([
    `Contact: mailto:${CONTACT.security}`,
    ...rest,
  ]);
  expect(securityTxt(now)).toBe(securityTxt(now, GITHUB_PRIVATE_REPORTING));
  // The security page offers it on the same switch.
  expect(source("security")).toContain("{GITHUB_PRIVATE_REPORTING ? <>, or report it privately");
  expect(ADVISORIES).toBe("https://github.com/north-brook/ponzu/security/advisories/new");
  const lines = securityTxt(now, false).trimEnd().split("\n");
  const expires = new Date(lines[1]!.slice("Expires: ".length));
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
