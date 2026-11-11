/// <reference types="vite/client" />
/*
 * The design boards' sample content as the product's types. The boards' local-era leftovers are
 * not reproduced: every repo design here is on a `pz/` branch, and "brand" is a repo like any
 * other.
 */
import type {
  Contributor,
  DesignMember,
  DesignSummary,
  Idea,
  ModelOption,
  PageTab,
  Person,
  PullRequestSummary,
  Repo,
  SearchResults,
  Workspace,
} from "../model.ts";
import alexAvatar from "./assets/alex.svg";
import bryceAvatar from "./assets/bryce.svg";
import jordanAvatar from "./assets/jordan.svg";
import mayaAvatar from "./assets/maya.svg";
import northbrookLogo from "./assets/northbrook.png";
import samAvatar from "./assets/sam.svg";
import brandPreview from "./previews/brand.png";
import checkoutPreview from "./previews/checkout.png";
import heroPreview from "./previews/hero.png";
import inboxPreview from "./previews/inbox.png";
import moodboardPreview from "./previews/moodboard.png";
import pricingPreview from "./previews/pricing.png";
import surveyPreview from "./previews/survey.png";

/** The gallery's clock: every age is measured from here. */
export const NOW = Date.parse("2026-11-10T16:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

export const bryce: Person = {
  id: "usr_bryce",
  name: "Bryce Bjork",
  login: "brycedbjork",
  avatarUrl: bryceAvatar,
};
export const sam: Person = {
  id: "usr_sam",
  name: "Sam Kim",
  login: "samkim",
  avatarUrl: samAvatar,
};
export const maya: Person = {
  id: "usr_maya",
  name: "Maya Ortiz",
  login: "mayaortiz",
  avatarUrl: mayaAvatar,
};
export const jordan: Person = {
  id: "usr_jordan",
  name: "Jordan Lee",
  login: "jordanlee",
  avatarUrl: jordanAvatar,
};
export const alex: Person = {
  id: "usr_alex",
  name: "Alex Rivera",
  login: "arivera",
  avatarUrl: alexAvatar,
};
export const teammates = [sam, maya, jordan, alex];

export const northbrook: Workspace = {
  id: "ws_northbrook",
  kind: "org",
  name: "Northbrook",
  login: "north-brook",
  avatarUrl: northbrookLogo,
};
export const fablefuel: Workspace = {
  id: "ws_fablefuel",
  kind: "org",
  name: "Fablefuel",
  login: "fablefuel",
  avatarUrl: null,
};
export const personal: Workspace = {
  id: "ws_bryce",
  kind: "personal",
  name: "Bryce Bjork",
  login: "brycedbjork",
  avatarUrl: bryceAvatar,
};
export const workspaces = [northbrook, fablefuel, personal];

const repo = (name: string): Repo => ({ id: `repo_${name}`, owner: "north-brook", name });
export const fernwood = repo("fernwood");
export const lenny = repo("lenny");
export const brand = repo("brand");
/** The repo picker's list, pushed-to lately first. */
export const repos = [fernwood, lenny, repo("ponzu"), repo("fablefuel")];

const preview = (src: string) => ({ light: src, dark: src });

export const pr412: PullRequestSummary = {
  number: 412,
  state: "open",
  checks: "passing",
  mergeable: true,
  autoMerge: false,
};
const pr405: PullRequestSummary = {
  number: 405,
  state: "open",
  checks: "running",
  mergeable: null,
  autoMerge: false,
};

function design(
  partial: Pick<DesignSummary, "id" | "name" | "project" | "preview"> & Partial<DesignSummary>,
): DesignSummary {
  return {
    status: "active",
    agentState: "idle",
    needsYou: 0,
    unseen: false,
    pullRequest: null,
    hereNow: [],
    owner: bryce,
    lastActivityAt: minutesAgo(60),
    settledAt: null,
    ...partial,
  };
}

const quieter = design({
  id: "dsn_quieter",
  name: "Quieter shop hero",
  project: { kind: "repo", repo: fernwood, branch: "pz/hero-refresh" },
  preview: preview(heroPreview),
  pullRequest: pr412,
  lastActivityAt: minutesAgo(2),
});
const pricing = design({
  id: "dsn_pricing",
  name: "Pricing page, three takes",
  project: { kind: "repo", repo: fernwood, branch: "pz/pricing" },
  preview: preview(pricingPreview),
  pullRequest: pr405,
  unseen: true,
  owner: maya,
  lastActivityAt: minutesAgo(20),
});
const moodboard = design({
  id: "dsn_moodboard",
  name: "Autumn drop moodboard",
  project: { kind: "scratch", city: "lisbon" },
  preview: preview(moodboardPreview),
  lastActivityAt: minutesAgo(45),
});
const survey = design({
  id: "dsn_survey",
  name: "Survey results readout",
  project: { kind: "repo", repo: lenny, branch: "pz/survey-readout" },
  preview: preview(surveyPreview),
  unseen: true,
  owner: jordan,
  lastActivityAt: minutesAgo(90),
});
const checkout = design({
  id: "dsn_checkout",
  name: "One-page checkout",
  project: { kind: "repo", repo: fernwood, branch: "pz/checkout" },
  preview: preview(checkoutPreview),
  owner: sam,
  lastActivityAt: minutesAgo(180),
});
const brandKit = design({
  id: "dsn_brand",
  name: "Brand kit for the relaunch",
  project: { kind: "repo", repo: brand, branch: "pz/relaunch" },
  preview: preview(brandPreview),
  owner: alex,
  lastActivityAt: minutesAgo(600),
});
const inbox = design({
  id: "dsn_inbox",
  name: "Support inbox triage",
  project: { kind: "repo", repo: lenny, branch: "pz/inbox-triage" },
  preview: preview(inboxPreview),
  owner: jordan,
  lastActivityAt: minutesAgo(900),
});

/** Mac boards 1 to 6: Northbrook with nobody else around. */
export const soloDesigns = [quieter, pricing, moodboard, survey, checkout, brandKit, inbox];
/** Board 1: the agent at work on the open design. */
export const soloWorking = soloDesigns.map((d) =>
  d === quieter ? { ...d, agentState: "working" as const } : d,
);

/** The team boards: a question waiting on you, a teammate's run, people in designs now. */
export const teamDesigns = [
  { ...quieter, needsYou: 2, hereNow: [sam, maya] },
  { ...checkout, agentState: "working" as const, lastActivityAt: minutesAgo(1) },
  { ...pricing, hereNow: [maya] },
  survey,
  { ...inbox, lastActivityAt: minutesAgo(100) },
  brandKit,
];

/** Board 6: a design that was just made, its agent building the first boards. */
export const justCreated = design({
  id: "dsn_onboarding",
  name: "Shorter onboarding flow",
  project: { kind: "repo", repo: fernwood, branch: "pz/onboarding" },
  preview: null,
  agentState: "working",
  lastActivityAt: minutesAgo(0),
});

export const settled: DesignSummary[] = [
  "Holiday gift guide",
  "Three takes on the hero",
  "Care card refresh",
  "Order emails",
  "Plant finder quiz",
  "Store locator",
  "Newsletter signup",
  "Returns page",
  "Loyalty card",
].map((name, i) =>
  design({
    id: `dsn_settled_${i}`,
    name,
    project: {
      kind: "repo",
      repo: i % 3 ? fernwood : lenny,
      branch: `pz/${name.toLowerCase().replaceAll(" ", "-")}`,
    },
    preview: null,
    status: "settled",
    pullRequest: {
      number: 380 - i * 7,
      state: "merged",
      checks: "passing",
      mergeable: true,
      autoMerge: false,
    },
    lastActivityAt: minutesAgo(60 * 24 * (5 + i * 16)),
    settledAt: minutesAgo(60 * 24 * (5 + i * 16)),
  }),
);

export const homePages: PageTab[] = [
  { id: "pg_home", name: "Home", icon: "home", working: false },
  { id: "pg_product", name: "Product", icon: "card", working: false },
  { id: "pg_care", name: "Care cards", icon: "list", working: false },
];

export const onboardingPages: PageTab[] = [
  { id: "pg_welcome", name: "Welcome", icon: "phone", working: true },
  { id: "pg_shorter", name: "Shorter flow", icon: "phone", working: false },
];

export const contributors: Contributor[] = [
  { person: bryce, here: true, lastHereAt: null },
  { person: sam, here: true, lastHereAt: null },
  { person: maya, here: true, lastHereAt: null },
  { person: jordan, here: false, lastHereAt: minutesAgo(60 * 24 * 2) },
];

export const members: DesignMember[] = [
  { person: bryce, access: "owner" },
  { person: sam, access: "edit" },
  { person: maya, access: "edit" },
  { person: jordan, access: "edit" },
  { person: alex, access: "edit" },
];

export const ideas: Idea[] = [
  { id: "idea_checkout", prompt: "Make checkout one page, with the order summary on the right" },
  { id: "idea_hero", prompt: "Three takes on the home hero that put the plants first" },
  { id: "idea_dark", prompt: "A dark mode for the shop, using the tokens you already have" },
  { id: "idea_empty", prompt: "Friendlier empty states for cart, orders and search" },
];

export const models: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
];

const threeTakes = settled[1]!;
export const heroResults: SearchResults = {
  query: "hero",
  designs: [
    { design: teamDesigns[0]!, matches: [[13, 17]] },
    { design: threeTakes, matches: [[19, 23]] },
  ],
  boards: [
    {
      id: "ab_hero_b",
      name: "Hero · B",
      matches: [[0, 4]],
      design: { id: quieter.id, name: quieter.name },
    },
    {
      id: "ab_hero_dark",
      name: "Hero, dark",
      matches: [[0, 4]],
      design: { id: brandKit.id, name: brandKit.name },
    },
  ],
  comments: [
    {
      id: "msg_serif",
      threadId: "th_serif",
      text: "Can C try the serif at a smaller size on the hero?",
      matches: [[44, 48]],
      author: maya,
      design: { id: quieter.id, name: quieter.name },
      at: minutesAgo(120),
    },
  ],
};
