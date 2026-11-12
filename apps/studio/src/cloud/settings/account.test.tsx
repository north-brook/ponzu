import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Analytics, noAnalytics } from "../../app/analytics/analytics.ts";
import { followUsageSharing, setUsageSharingHere } from "../../app/analytics/sharing.ts";
import { ada } from "../gallery/fixtures.ts";
import { TipProvider } from "../ui/tooltip.tsx";
import { ACCOUNT_LINKS, AccountSection, type AccountSectionProps } from "./account.tsx";
import { Row, Section } from "./parts.tsx";

/*
 * Settings › Account's Usage data row (site design §9): its words, its toggle, the line it shows
 * once turned on in a window that loaded nothing to report with, and the Privacy · Terms foot.
 * Then what flipping it does in the window and to the shell, on fakes.
 */

const ignore = () => {};

function account(over: Partial<AccountSectionProps> = {}) {
  return (
    <AccountSection
      me={ada}
      email="ada@example.com"
      teams={[]}
      onSignOut={ignore}
      onCreateTeam={ignore}
      onDelete={ignore}
      usage={{ on: true, onChange: ignore, resumesNextLaunch: false }}
      onOpenLink={ignore}
      {...over}
    />
  );
}

const html = (over: Partial<AccountSectionProps> = {}) =>
  renderToStaticMarkup(<TipProvider>{account(over)}</TipProvider>);

/** Every element under `node`, depth first, as React holds them (nothing is rendered). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    found.push(child, ...elements(child.props.children as ReactNode));
  });
  return found;
}

test("Usage data sits between Teams and the Danger zone, with the design's words and a toggle", () => {
  const page = html();
  const order = ["Teams", "Usage data", "Danger zone"].map((label) =>
    page.indexOf(`aria-label="${label}"`),
  );
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(page).toContain("Share usage data");
  expect(page).toContain("Usage, errors and screen recordings, with your work hidden.");
  expect(page).toContain("Learn more");
  expect(page).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-label="Share usage data"/);
  expect(html({ usage: { on: false, onChange: ignore, resumesNextLaunch: false } })).toMatch(
    /aria-checked="false"/,
  );
  // An API that says nothing about it: no row.
  expect(html({ usage: undefined })).not.toContain("Usage data");
});

test("turned on where nothing was loaded to report with, it says when recording resumes", () => {
  const page = html({ usage: { on: true, onChange: ignore, resumesNextLaunch: true } });
  expect(page).toContain("Recording resumes next time Ponzu opens");
  expect(page).not.toContain("with your work hidden");
});

test("the toggle, Learn more and the Privacy · Terms foot each do what they say", () => {
  const flipped: boolean[] = [];
  const opened: string[] = [];
  const tree = account({
    usage: { on: true, onChange: (on) => flipped.push(on), resumesNextLaunch: false },
    onOpenLink: (url) => opened.push(url),
  });
  const parts = elements(AccountSection(tree.props as AccountSectionProps));
  const usage = parts.find((el) => el.type === Section && el.props.label === "Usage data")!;
  const row = elements(usage.props.children as ReactNode).find((el) => el.type === Row)!;
  const toggle = row.props.trailing as ReactElement<{ onCheckedChange: (on: boolean) => void }>;
  toggle.props.onCheckedChange(false);
  expect(flipped).toEqual([false]);

  const learnMore = usage.props.note as ReactElement<{ onClick: () => void }>;
  learnMore.props.onClick();
  const foot = parts.filter((el) => el.type === "button" && typeof el.props.onClick === "function");
  for (const button of foot) {
    if (button.props.children === "Privacy" || button.props.children === "Terms") {
      (button.props.onClick as () => void)();
    }
  }
  expect(opened).toEqual([ACCOUNT_LINKS.analytics, ACCOUNT_LINKS.privacy, ACCOUNT_LINKS.terms]);
  expect(ACCOUNT_LINKS).toEqual({
    analytics: "https://ponzu.design/privacy#analytics",
    privacy: "https://ponzu.design/privacy",
    terms: "https://ponzu.design/terms",
  });
});

/** A window's analytics that records what it was told, reporting or not. */
function recording(reporting: boolean) {
  const said: boolean[] = [];
  const analytics: Analytics = {
    ...noAnalytics,
    reporting,
    setSharing: (on) => void said.push(on),
  };
  return { analytics, said };
}

/** A shell that records what it was told, and says whether its next launch would report. */
function shell(nextLaunchReports: boolean) {
  const told: boolean[] = [];
  return {
    told,
    host: {
      setUsageSharing: async (on: boolean) => {
        told.push(on);
        return on && nextLaunchReports;
      },
    },
  };
}

test("turning it off here stops this window at once and tells the shell", async () => {
  const w = recording(true);
  const s = shell(true);
  expect(await setUsageSharingHere(w.analytics, s.host, false)).toBe(false);
  expect(w.said).toEqual([false]);
  expect(s.told).toEqual([false]);
});

test("turning it on here: at once where PostHog is loaded, at the next launch where it was not", async () => {
  const loaded = recording(true);
  expect(await setUsageSharingHere(loaded.analytics, shell(true).host, true)).toBe(false);
  expect(loaded.said).toEqual([true]);

  const notLoaded = recording(false);
  expect(await setUsageSharingHere(notLoaded.analytics, shell(true).host, true)).toBe(true);
  // A build or a computer that will not report next time either: nothing to promise.
  expect(await setUsageSharingHere(notLoaded.analytics, shell(false).host, true)).toBe(false);
  // No shell at all (a browser): nothing to promise.
  expect(await setUsageSharingHere(notLoaded.analytics, {}, true)).toBe(false);
});

test("off from another device stops this window and its shell; on from elsewhere never writes the shell's file", () => {
  const w = recording(true);
  const s = shell(true);
  followUsageSharing(w.analytics, s.host, false);
  expect(w.said).toEqual([false]);
  expect(s.told).toEqual([false]);

  followUsageSharing(w.analytics, s.host, true);
  expect(w.said).toEqual([false, true]);
  expect(s.told).toEqual([false]);

  // A window that loaded nothing has nothing of its own to stop, and leaves the file be.
  const quiet = recording(false);
  const t = shell(true);
  followUsageSharing(quiet.analytics, t.host, false);
  expect(t.told).toEqual([]);
});
