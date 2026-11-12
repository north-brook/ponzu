/*
 * The guided setup's and Settings' sample content, from the onboarding, settings and pricing
 * boards, as the product's types. Absolute dates are built in local time, so "Nov 2" and
 * "Monday 9:00" read the same in any time zone.
 */
import type { ClaudeConnection, ClaudeLimit } from "../claude.ts";
import type { Card, PersonUsage, Usage } from "../settings/billing.ts";
import type { RepoEnvironment } from "../settings/environments.ts";
import type { Installation } from "../settings/github.tsx";
import type { Member } from "../settings/members.ts";
import type { PingDevice, PingPrefs } from "../settings/notifications.tsx";
import type { CanvasUsage } from "../settings/plan.tsx";
import type { GithubAccount } from "../setup/setup.ts";
import {
  alex,
  bryce,
  fernwood,
  jordan,
  lenny,
  leo,
  maya,
  NOW,
  northbrook,
  repos,
  sam,
  ting,
} from "./fixtures.ts";

const local = (month: number, day: number, hour = 12, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).toISOString();

export const email = "bryce@northbrook.co";

// Where do you build: the person's own account, and the organizations Ponzu is installed on.
export const personalAccount: GithubAccount = {
  githubAccountId: 1001,
  login: bryce.login,
  name: bryce.name,
  avatarUrl: bryce.avatarUrl,
  kind: "personal",
  status: "not_installed",
  workspaceId: null,
  suspended: false,
  memberCount: null,
};
export const accounts: GithubAccount[] = [
  personalAccount,
  {
    githubAccountId: 2001,
    login: "fablefuel",
    name: "Fablefuel",
    avatarUrl: null,
    kind: "org",
    status: "ready",
    workspaceId: "ws_fablefuel",
    suspended: false,
    memberCount: 12,
  },
  {
    githubAccountId: 2002,
    login: northbrook.login,
    name: northbrook.name,
    avatarUrl: northbrook.avatarUrl,
    kind: "org",
    status: "ready",
    workspaceId: northbrook.id,
    suspended: false,
    memberCount: 5,
  },
];
/** Nothing set up yet: only the person's own account, and Continue waits. */
export const nothingReady: GithubAccount[] = [personalAccount];
/** A person in a dozen organizations: more rows than a short window holds. */
export const manyAccounts: GithubAccount[] = [
  ...accounts,
  ...[
    "Kettle",
    "Halyard",
    "Moss & Co",
    "Tidewater",
    "Lumen",
    "Orchard",
    "Paperjam",
    "Quarry",
    "Ridgeline",
  ].map(
    (name, i): GithubAccount => ({
      githubAccountId: 3001 + i,
      login: name.toLowerCase().replace(/[^a-z]/g, ""),
      name,
      avatarUrl: null,
      kind: "org",
      status: "ready",
      workspaceId: `ws_${i}`,
      suspended: false,
      memberCount: 3 + i,
    }),
  ),
];
/** The person's own account ready, and an organization whose installation is suspended. */
export const suspendedAccounts: GithubAccount[] = [
  { ...personalAccount, status: "ready", workspaceId: "ws_bryce" },
  { ...accounts[2]!, suspended: true },
];

export const claudeMax: ClaudeConnection = {
  method: "subscription",
  status: "connected",
  planLabel: "Claude Max",
  email,
  keyHint: null,
  connectedAt: local(11, 2),
  expiresAt: local(11, 2, 12, 0, 2027),
};
export const claudeKey: ClaudeConnection = {
  ...claudeMax,
  method: "api_key",
  planLabel: null,
  email: null,
  keyHint: "4f2a",
  expiresAt: null,
};
export const claudeExpiring: ClaudeConnection = { ...claudeMax, expiresAt: local(12, 2) };
export const claudeRevoked: ClaudeConnection = { ...claudeMax, status: "revoked" };

export const limits: ClaudeLimit[] = [
  { window: "session", utilization: 0.62, resetsAt: new Date(NOW + 134 * 60_000).toISOString() },
  { window: "week", utilization: 0.38, resetsAt: local(11, 16, 9) },
  { window: "week_opus", utilization: 0.71, resetsAt: local(11, 16, 9) },
];
export const limitsFull: ClaudeLimit[] = [
  { window: "session", utilization: 1, resetsAt: new Date(NOW + 60 * 60_000).toISOString() },
  { window: "week", utilization: 0.64, resetsAt: local(11, 16, 9) },
  { window: "week_opus", utilization: 1, resetsAt: local(11, 16, 9) },
];
export const limitsUnseen: ClaudeLimit[] = limits.map((l) => ({
  ...l,
  utilization: null,
  resetsAt: null,
}));

export const pingPrefs: PingPrefs = {
  needsYou: true,
  replies: true,
  prReady: true,
  teammateComments: false,
  emailDigest: false,
};
export const iphone: PingDevice = {
  id: "dev_iphone",
  name: "iPhone 16 Pro",
  pings: true,
  blocked: false,
};

export const members: Member[] = [
  { person: bryce, joined: true, role: "admin", owner: true },
  { person: sam, joined: true, role: "admin", owner: false },
  { person: maya, joined: true, role: "member", owner: false },
  { person: jordan, joined: true, role: "member", owner: false },
  { person: alex, joined: true, role: "member", owner: false },
];

/** The team with two people GitHub gives access who haven't opened Ponzu yet. */
export const membersMixed: Member[] = [
  ...members.slice(0, 3),
  { person: ting, joined: false, role: null, owner: true },
  { person: leo, joined: false, role: null, owner: false },
];

export const installation: Installation = {
  state: "installed",
  accountLogin: northbrook.login,
  installedBy: bryce.login,
  installedAt: local(10, 28),
};
export const githubRepos = repos;

const ponzu = repos.find((r) => r.name === "ponzu")!;
export const environments: RepoEnvironment[] = [
  {
    repo: fernwood,
    base: {
      status: "ready",
      builtAt: new Date(NOW - 2 * 24 * 3_600_000).toISOString(),
      stack: [
        { slug: "nodedotjs", label: "Node 22" },
        { slug: "pnpm", label: "pnpm 9" },
        { slug: "postgresql", label: "Postgres 16" },
      ],
    },
    secrets: [
      { name: "DATABASE_URL", updatedAt: local(11, 3) },
      { name: "STRIPE_SECRET_KEY", updatedAt: local(11, 3) },
    ],
  },
  {
    repo: lenny,
    base: {
      status: "ready",
      builtAt: new Date(NOW - 5 * 24 * 3_600_000).toISOString(),
      stack: [
        { slug: "python", label: "Python 3.13" },
        { slug: "postgresql", label: "Postgres 16" },
      ],
    },
    secrets: [],
  },
  {
    repo: ponzu,
    base: {
      status: "ready",
      builtAt: new Date(NOW - 9 * 24 * 3_600_000).toISOString(),
      stack: [{ slug: "bun", label: "Bun 1.3" }],
    },
    secrets: [{ name: "ANTHROPIC_API_KEY", updatedAt: local(11, 1) }],
  },
];

/** Bases built on other stacks, the last with a service Ponzu has no logo for. */
const built = (name: string, stack: RepoEnvironment["base"]["stack"]): RepoEnvironment => ({
  repo: { ...fernwood, id: `repo_${name}`, name },
  base: { status: "ready", builtAt: new Date(NOW - 3 * 24 * 3_600_000).toISOString(), stack },
  secrets: [],
});
export const otherStacks: RepoEnvironment[] = [
  built("api", [
    { slug: "go", label: "Go 1.23" },
    { slug: "redis", label: "Redis 7" },
    { slug: "docker", label: "Docker" },
  ]),
  built("storefront", [
    { slug: "ruby", label: "Ruby 3.3" },
    { slug: "yarn", label: "Yarn 4" },
    { slug: "mysql", label: "MySQL 8" },
  ]),
  built("engine", [
    { slug: "rust", label: "Rust 1.82" },
    { slug: "quickwit", label: "Quickwit 0.8" },
  ]),
];

const visa = (last4: string): Card => ({ brand: "visa", last4, failed: false });
const periodEnd = local(12, 9);

/** The solo board: 64 awake hours, a $50 cap. */
export const soloUsage: Usage = {
  usedCredits: 320,
  freeCredits: 100,
  creditUsd: 0.1,
  capUsd: 50,
  periodEnd,
  card: visa("4242"),
};
/** Still inside the free credits, and no card yet. */
export const freeUsage: Usage = { ...soloUsage, usedCredits: 60, capUsd: null, card: null };
/** The team board: 412 awake hours across five people, 100 free credits each, a $500 cap. */
export const teamUsage: Usage = {
  ...soloUsage,
  usedCredits: 2060,
  freeCredits: 500,
  capUsd: 500,
  card: visa("8831"),
};
export const byPerson: PersonUsage[] = [
  { person: bryce, admin: true, usedCredits: 705 },
  { person: sam, admin: true, usedCredits: 560 },
  { person: maya, admin: false, usedCredits: 480 },
  { person: jordan, admin: false, usedCredits: 205 },
  { person: alex, admin: false, usedCredits: 110 },
];
/**
 * The same period with someone's account deleted (30 of Alex's credits put down to nobody) and
 * by canvas, with deleted canvases and canvases the viewer can't open: each adds up to 2,060.
 */
export const byPersonWithNobody: PersonUsage[] = byPerson.map((row) =>
  row.person.id === alex.id ? { ...row, usedCredits: 80 } : row,
);
export const unattributedCredits = 30;
export const byCanvas: CanvasUsage[] = [
  { kind: "canvas", id: "cnv_checkout", name: "Checkout, one page", usedCredits: 940 },
  { kind: "canvas", id: "cnv_onboarding", name: "Onboarding tour", usedCredits: 610 },
  { kind: "canvas", id: "cnv_empty", name: "Empty states", usedCredits: 0 },
  { kind: "deleted", id: null, name: null, usedCredits: 330 },
  { kind: "hidden", id: null, name: null, usedCredits: 180 },
];
