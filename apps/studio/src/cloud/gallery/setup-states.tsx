/* Settings' sections in the states the boards don't draw, each in place at the modal's size. */
import type { ReactNode } from "react";
import type { PastDue } from "../settings/billing.ts";
import type { SettingsSection } from "../settings/settings-modal.tsx";
import * as f from "./fixtures.ts";
import * as s from "./setup-fixtures.ts";
import {
  type SettingsData,
  SettingsInPlace,
  SOLO_SETTINGS,
  TEAM_SETTINGS,
} from "./setup-harness.tsx";

const team = (patch: Partial<SettingsData>): SettingsData => ({ ...TEAM_SETTINGS, ...patch });
const failedPayment: PastDue = {
  reason: "failed",
  invoiceUrl: "https://invoice.stripe.com/i/acct_1/test_1",
};

const STATES: [string, SettingsSection, SettingsData][] = [
  [
    "Account · in two teams",
    "account",
    team({
      teams: [
        { workspace: f.thistlewick, role: "admin" },
        { workspace: f.quillmoor, role: "member" },
      ],
    }),
  ],
  ["Account · solo", "account", SOLO_SETTINGS],
  ["Agents · an API key", "agents", team({ connection: s.claudeKey })],
  ["Agents · nothing connected", "agents", team({ connection: null })],
  [
    "Agents · switching to an API key",
    "agents",
    team({ entry: { mode: "api_key", key: "", status: "idle" } }),
  ],
  ["Agents · sign in again soon", "agents", team({ connection: s.claudeExpiring })],
  ["Agents · signed out", "agents", team({ connection: s.claudeRevoked })],
  ["Agents · a limit reached", "agents", team({ limits: s.limitsFull })],
  ["Agents · limits not seen yet", "agents", team({ limits: s.limitsUnseen })],
  ["Notifications · solo, no iPhone", "notifications", { ...SOLO_SETTINGS, devices: [] }],
  [
    "Notifications · blocked in iOS",
    "notifications",
    team({ devices: [{ ...s.iphone, blocked: true }] }),
  ],
  [
    "Notifications · This Mac, another Mac and an iPhone",
    "notifications",
    team({ devices: [s.thisMac, s.otherMac, s.iphone] }),
  ],
  ["Notifications · This Mac, no iPhone yet", "notifications", team({ devices: [s.thisMac] })],
  [
    "Notifications · no email yet",
    "notifications",
    team({ devices: [s.thisMac, s.iphone], emailAvailable: false }),
  ],
  [
    "Notifications · email, not an admin anywhere",
    "notifications",
    team({ devices: [s.thisMac, s.iphone], teamAvailable: false }),
  ],
  ["Members · as a member", "members", team({ meId: f.maya.id })],
  [
    "Members · the last admin",
    "members",
    team({
      meId: f.sam.id,
      members: s.members.map((m) => ({
        ...m,
        joined: true,
        role: m.person.id === f.sam.id ? "admin" : "member",
        owner: false,
      })),
    }),
  ],
  // GitHub gives access to people who haven't opened Ponzu: listed, quieter, with no role.
  ["Members · some haven't opened Ponzu", "members", team({ members: s.membersMixed })],
  [
    "Members · some haven't opened Ponzu, as a member",
    "members",
    team({ members: s.membersMixed, meId: f.maya.id }),
  ],
  ["Members · GitHub unreachable", "members", team({ syncFailed: true })],
  [
    "GitHub · suspended",
    "github",
    team({ installation: { ...s.installation, state: "suspended" } }),
  ],
  [
    "GitHub · not installed",
    "github",
    team({ installation: { ...s.installation, state: "not_installed" } }),
  ],
  ["GitHub · no repos yet", "github", team({ repos: [] })],
  ["Environments · nothing yet", "environments", team({ environments: [] })],
  [
    "Environments · rebuilding, and failed",
    "environments",
    team({
      environments: s.environments.map((e, i) =>
        i === 0
          ? { ...e, base: { ...e.base, status: "building" } }
          : i === 1
            ? { ...e, base: { ...e.base, status: "failed" } }
            : e,
      ),
      open: s.environments.slice(0, 2).map((e) => e.repo.id),
    }),
  ],
  ["Environments · as a member", "environments", team({ meId: f.maya.id })],
  [
    "Environments · other stacks, one without a logo",
    "environments",
    team({ environments: s.otherStacks, open: [s.otherStacks[2]!.repo.id] }),
  ],
  ["Plan and usage · no card yet", "plan", { ...SOLO_SETTINGS, usage: s.freeUsage }],
  [
    "Plan and usage · at the cap",
    "plan",
    { ...SOLO_SETTINGS, usage: { ...s.soloUsage, usedCredits: 600 } },
  ],
  [
    "Plan and usage · payment failed",
    "plan",
    { ...SOLO_SETTINGS, usage: { ...s.soloUsage, pastDue: failedPayment } },
  ],
  [
    "Plan and usage · a payment needs confirming",
    "plan",
    {
      ...SOLO_SETTINGS,
      usage: { ...s.soloUsage, pastDue: { ...failedPayment, reason: "needs_confirmation" } },
    },
  ],
  [
    "Plan and usage · a payment failed, then the card was removed",
    "plan",
    { ...SOLO_SETTINGS, usage: { ...s.freeUsage, pastDue: failedPayment } },
  ],
  [
    "Plan and usage · a wallet's card, with no digits",
    "plan",
    { ...SOLO_SETTINGS, usage: { ...s.soloUsage, card: { brand: "other", last4: null } } },
  ],
  ["Plan and usage · a team's member", "plan", team({ meId: f.maya.id, byPerson: null })],
  [
    "Plan and usage · by canvas, a deleted account and deleted canvases",
    "plan",
    team({
      byPerson: s.byPersonWithNobody,
      unattributedCredits: s.unattributedCredits,
      byCanvas: s.byCanvas,
    }),
  ],
];

export function SetupStates({
  section,
}: {
  section: (title: string, children: ReactNode) => ReactNode;
}) {
  return (
    <>
      {STATES.map(([title, settingsSection, data]) =>
        section(title, <SettingsInPlace section={settingsSection} data={data} />),
      )}
    </>
  );
}
