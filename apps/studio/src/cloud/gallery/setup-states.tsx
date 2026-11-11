/* Settings' sections in the states the boards don't draw, each in place at the modal's size. */
import type { ReactNode } from "react";
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
const failedPayment = { ...s.soloUsage.card!, failed: true };

const STATES: [string, SettingsSection, SettingsData][] = [
  [
    "Account · in two teams",
    "account",
    team({
      teams: [
        { workspace: f.northbrook, role: "admin" },
        { workspace: f.fablefuel, role: "member" },
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
  ["Members · as a member", "members", team({ meId: f.maya.id })],
  [
    "Members · the last admin",
    "members",
    team({
      meId: f.sam.id,
      members: s.members.map((m) => ({
        ...m,
        role: m.person.id === f.sam.id ? "admin" : "member",
        owner: false,
      })),
    }),
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
  ["Plan and usage · no card yet", "plan", { ...SOLO_SETTINGS, usage: s.freeUsage }],
  [
    "Plan and usage · at the cap",
    "plan",
    { ...SOLO_SETTINGS, usage: { ...s.soloUsage, usedCredits: 600 } },
  ],
  [
    "Plan and usage · payment failed",
    "plan",
    { ...SOLO_SETTINGS, usage: { ...s.soloUsage, card: failedPayment } },
  ],
  ["Plan and usage · a team's member", "plan", team({ meId: f.maya.id, byPerson: null })],
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
