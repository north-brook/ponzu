import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TipProvider } from "../ui/tooltip.tsx";
import {
  BILLING_EMAILS,
  NotificationsSection,
  type NotificationsSectionProps,
  type PingPref,
  type PingPrefs,
} from "./notifications.tsx";
import { Row, Section } from "./parts.tsx";

/*
 * Settings › Notifications › Email (docs/cloud.md, "Email"): hidden while the API can't send
 * email, so the Mac looks as it did before; once it can, a caption saying where email goes, the
 * digest, the recap and (for someone the "people joined" email could reach) that one, and the
 * fixed billing line. A switch saves only itself.
 */

const ignore = () => {};

/** What an API with email off answers, as before email had more than one kind. */
const OFF: PingPrefs = {
  needsYou: true,
  replies: true,
  prReady: true,
  teammateComments: false,
  emailDigest: false,
};
/** What an API that can send email answers. */
const ON: PingPrefs = { ...OFF, emailTeam: true, emailRecap: true };

const mac = { id: "dev_mac", kind: "mac" as const, name: "This Mac", pings: true, blocked: false };

function props(over: Partial<NotificationsSectionProps> = {}): NotificationsSectionProps {
  return {
    prefs: ON,
    onPrefChange: ignore,
    devices: [mac],
    onDeviceChange: ignore,
    email: "maya@northbrook.com",
    emailAvailable: true,
    teamAvailable: true,
    team: true,
    onGetIphone: ignore,
    ...over,
  };
}

const html = (over: Partial<NotificationsSectionProps> = {}) =>
  renderToStaticMarkup(
    <TipProvider>
      <NotificationsSection {...props(over)} />
    </TipProvider>,
  );

/** Every element under `node`, depth first, as React holds them (nothing is rendered). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    found.push(child, ...elements(child.props.children as ReactNode));
  });
  return found;
}

const sections = (over: Partial<NotificationsSectionProps> = {}) =>
  elements(NotificationsSection(props(over))).filter((el) => el.type === Section);

/** The switches' labels, in order. */
const switches = (page: string) =>
  [...page.matchAll(/role="switch"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);

test("with email off there is no Email group, and nothing else about email, as before", () => {
  // Off, an API answers neither new switch; and a Mac that still holds them shows nothing more.
  for (const prefs of [OFF, ON]) {
    for (const teamAvailable of [false, true]) {
      const page = html({ prefs, emailAvailable: false, teamAvailable });
      expect(
        sections({ prefs, emailAvailable: false, teamAvailable }).map((s) => s.props.label),
      ).toEqual(["Ping me when", "Where"]);
      expect(page).not.toMatch(/email|digest|recap|people join/i);
      expect(page).not.toContain("maya@northbrook.com");
      expect(switches(page)).toEqual([
        "Ponzu needs you",
        "Ponzu replies to my comment",
        "A pull request is ready",
        "A teammate comments",
        "This Mac",
      ]);
    }
  }
});

test("with email on: the caption, three switches in their words, and the billing line", () => {
  const page = html();
  expect(sections().map((s) => s.props.label)).toEqual(["Ping me when", "Where", "Email"]);
  expect(page).toContain("Emails go to maya@northbrook.com, your GitHub email.");
  expect(page).toContain("What you missed, once a day at 9.");
  expect(page).toContain("What you shipped, in weeks something merged.");
  expect(page).toContain("Workspaces you&#x27;re an admin of.");
  expect(page).toContain("Billing emails go to every admin and can&#x27;t be turned off.");
  expect(BILLING_EMAILS).toBe("Billing emails go to every admin and can't be turned off.");
  expect(switches(page).slice(-3)).toEqual(["Daily digest", "Friday recap", "When people join"]);
  // The Where section keeps its devices only: the old Email row is now the group.
  const where = sections().find((s) => s.props.label === "Where")!;
  expect(elements(where.props.children as ReactNode).filter((el) => el.type === Row)).toHaveLength(
    1 + 1, // This Mac, and the row that gets an iPhone
  );
});

test("each email switch shows what the API answered", () => {
  const page = html({ prefs: { ...ON, emailDigest: true, emailRecap: false, emailTeam: true } });
  const state = (label: string) =>
    page.match(
      new RegExp(`role="switch"[^>]*aria-checked="(\\w+)"[^>]*aria-label="${label}"`),
    )?.[1];
  expect(state("Daily digest")).toBe("true");
  expect(state("Friday recap")).toBe("false");
  expect(state("When people join")).toBe("true");
});

test("someone the people-joined email can't reach has no row for it", () => {
  const page = html({ teamAvailable: false });
  expect(switches(page).slice(-2)).toEqual(["Daily digest", "Friday recap"]);
  expect(page).not.toContain("When people join");
  expect(page).toContain("Billing emails go to every admin");
});

test("a switch the API did not answer has no row", () => {
  // An API that can send email but answers only the digest (as one from before the recap would).
  const page = html({ prefs: OFF });
  expect(switches(page).slice(-1)).toEqual(["Daily digest"]);
  expect(page).not.toMatch(/Friday recap|When people join/);
});

test("with no address known, the caption still says where email goes", () => {
  expect(html({ email: null })).toContain("Emails go to your GitHub email.");
});

test("a switch saves only itself, never the rest of what is shown", () => {
  const saved: [PingPref, boolean][] = [];
  const email = sections({ onPrefChange: (pref, on) => saved.push([pref, on]) }).find(
    (s) => s.props.label === "Email",
  )!;
  for (const row of elements(email.props.children as ReactNode).filter((el) => el.type === Row)) {
    const toggle = row.props.trailing as ReactElement<{
      checked: boolean;
      onCheckedChange: (on: boolean) => void;
    }>;
    toggle.props.onCheckedChange(!toggle.props.checked);
  }
  expect(saved).toEqual([
    ["emailDigest", true],
    ["emailRecap", false],
    ["emailTeam", false],
  ]);
});
