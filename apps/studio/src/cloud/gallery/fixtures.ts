/// <reference types="vite/client" />
/*
 * The mockup boards' sample content as the product's types. The boards' local-era leftovers are
 * not reproduced: every repo canvas here is on a `pz/` branch, and "brand" is a repo like any
 * other.
 */
import type {
  CanvasMember,
  CanvasSummary,
  Contributor,
  Idea,
  ModelOption,
  PageTab,
  Person,
  PullRequestSummary,
  Repo,
  SearchResults,
  Workspace,
} from "../model.ts";
import adaAvatar from "./assets/ada.svg";
import alexAvatar from "./assets/alex.svg";
import jordanAvatar from "./assets/jordan.svg";
import mayaAvatar from "./assets/maya.svg";
import samAvatar from "./assets/sam.svg";
import thistlewickLogo from "./assets/thistlewick.svg";
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

export const ada: Person = {
  id: "usr_ada",
  name: "Ada Park",
  login: "adapark",
  avatarUrl: adaAvatar,
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
/** On the team on GitHub, and haven't opened Ponzu yet: no Ponzu user, keyed by GitHub id. */
export const ting: Person = {
  id: "github:5101",
  name: "Ting Gao",
  login: "tinggao",
  avatarUrl: null,
};
export const leo: Person = {
  id: "github:5102",
  name: "Leo Park",
  login: "leopark",
  avatarUrl: null,
};

export const thistlewick: Workspace = {
  id: "ws_thistlewick",
  kind: "org",
  name: "Thistlewick",
  login: "thistlewick",
  avatarUrl: thistlewickLogo,
};
export const quillmoor: Workspace = {
  id: "ws_quillmoor",
  kind: "org",
  name: "Quillmoor",
  login: "quillmoor",
  avatarUrl: null,
};
export const personal: Workspace = {
  id: "ws_ada",
  kind: "personal",
  name: "Ada Park",
  login: "adapark",
  avatarUrl: adaAvatar,
};
export const workspaces = [thistlewick, quillmoor, personal];

const repo = (name: string): Repo => ({ id: `repo_${name}`, owner: "thistlewick", name });
export const fernwood = repo("fernwood");
export const almanac = repo("almanac");
export const brand = repo("brand");
/** The repo picker's list, pushed-to lately first. */
export const repos = [fernwood, almanac, repo("ponzu"), repo("quillmoor")];
/** A workspace with just the one repo installed. */
export const oneRepo = [repo("ponzu-test")];
/** Enough to scroll, and a name too long for the row. */
export const manyRepos = [
  fernwood,
  almanac,
  repo("ponzu"),
  repo("quillmoor"),
  repo("customer-onboarding-experiments-and-landing-page-variants"),
  repo("brand"),
  repo("thistlewick.com"),
  repo("design-system"),
  repo("mobile"),
  repo("api"),
  repo("docs"),
  repo("sandbox-images"),
  repo("press-kit"),
  repo("dotfiles"),
  repo("infra"),
];

/** A second organization the person is in, for the picker across workspaces. */
export const brambleSchool: Workspace = {
  id: "ws_brambleschool",
  kind: "org",
  name: "Bramble School",
  login: "brambleschool",
  avatarUrl: null,
};
const brambleRepo = (name: string): Repo => ({
  id: `repo_brambleschool_${name}`,
  owner: "brambleschool",
  name,
});
/** Bramble School's repos, pushed-to lately first. */
export const brambleRepos = [brambleRepo("app"), brambleRepo("site"), brambleRepo("curriculum")];
/** Each workspace's repos, for a person in Thistlewick and Bramble School. */
export const shelves: Record<string, Repo[]> = {
  [thistlewick.id]: repos,
  [brambleSchool.id]: brambleRepos,
};
/** The person's own repos, in their personal workspace. */
export const personalRepos: Repo[] = [
  { id: "repo_adapark_dotfiles", owner: "adapark", name: "dotfiles" },
];
/** And in their personal workspace too, the switcher's third. */
export const threeShelves: Record<string, Repo[]> = {
  ...shelves,
  [personal.id]: personalRepos,
};
/** A repo whose owner and name are both too long for the header. */
export const longNamedRepo: Repo = {
  id: "repo_long",
  owner: "the-extraordinarily-long-organization-name",
  name: "customer-onboarding-experiments-and-landing-page-variants",
};

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

function canvas(
  partial: Pick<CanvasSummary, "id" | "name" | "project" | "preview"> & Partial<CanvasSummary>,
): CanvasSummary {
  return {
    status: "active",
    agentState: "idle",
    needsYou: 0,
    unseen: false,
    pullRequest: null,
    hereNow: [],
    owner: ada,
    lastActivityAt: minutesAgo(60),
    settledAt: null,
    ...partial,
  };
}

const quieter = canvas({
  id: "cnv_quieter",
  name: "Quieter shop hero",
  project: { kind: "repo", repo: fernwood, branch: "pz/hero-refresh" },
  preview: preview(heroPreview),
  pullRequest: pr412,
  lastActivityAt: minutesAgo(2),
});
const pricing = canvas({
  id: "cnv_pricing",
  name: "Pricing page, three takes",
  project: { kind: "repo", repo: fernwood, branch: "pz/pricing" },
  preview: preview(pricingPreview),
  pullRequest: pr405,
  unseen: true,
  owner: maya,
  lastActivityAt: minutesAgo(20),
});
const moodboard = canvas({
  id: "cnv_moodboard",
  name: "Autumn drop moodboard",
  project: { kind: "scratch", city: "lisbon" },
  preview: preview(moodboardPreview),
  lastActivityAt: minutesAgo(45),
});
const survey = canvas({
  id: "cnv_survey",
  name: "Survey results readout",
  project: { kind: "repo", repo: almanac, branch: "pz/survey-readout" },
  preview: preview(surveyPreview),
  unseen: true,
  owner: jordan,
  lastActivityAt: minutesAgo(90),
});
const checkout = canvas({
  id: "cnv_checkout",
  name: "One-page checkout",
  project: { kind: "repo", repo: fernwood, branch: "pz/checkout" },
  preview: preview(checkoutPreview),
  owner: sam,
  lastActivityAt: minutesAgo(180),
});
const brandKit = canvas({
  id: "cnv_brand",
  name: "Brand kit for the relaunch",
  project: { kind: "repo", repo: brand, branch: "pz/relaunch" },
  preview: preview(brandPreview),
  owner: alex,
  lastActivityAt: minutesAgo(600),
});
const inbox = canvas({
  id: "cnv_inbox",
  name: "Support inbox triage",
  project: { kind: "repo", repo: almanac, branch: "pz/inbox-triage" },
  preview: preview(inboxPreview),
  owner: jordan,
  lastActivityAt: minutesAgo(900),
});

/** Mac boards 1 to 6: Thistlewick with nobody else around. */
export const soloCanvases = [quieter, pricing, moodboard, survey, checkout, brandKit, inbox];
/** Board 1: the agent at work on the open canvas. */
export const soloWorking = soloCanvases.map((d) =>
  d === quieter ? { ...d, agentState: "working" as const } : d,
);

/** The team boards: a question waiting on you, a teammate's run, people in canvases now. */
export const teamCanvases = [
  { ...quieter, needsYou: 2, hereNow: [sam, maya] },
  { ...checkout, agentState: "working" as const, lastActivityAt: minutesAgo(1) },
  { ...pricing, hereNow: [maya] },
  survey,
  { ...inbox, lastActivityAt: minutesAgo(100) },
  brandKit,
];

/** Board 6: a canvas that was just made, its agent building the first boards. */
export const justCreated = canvas({
  id: "cnv_onboarding",
  name: "Shorter onboarding flow",
  project: { kind: "repo", repo: fernwood, branch: "pz/onboarding" },
  preview: null,
  agentState: "working",
  lastActivityAt: minutesAgo(0),
});

export const settled: CanvasSummary[] = [
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
  canvas({
    id: `cnv_settled_${i}`,
    name,
    project: {
      kind: "repo",
      repo: i % 3 ? fernwood : almanac,
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
  { person: ada, here: true, lastHereAt: null },
  { person: sam, here: true, lastHereAt: null },
  { person: maya, here: true, lastHereAt: null },
  { person: jordan, here: false, lastHereAt: minutesAgo(60 * 24 * 2) },
];

/** A canvas only you have worked on: the spec's default still shows you and the "+". */
export const justYou: Contributor[] = [{ person: ada, here: true, lastHereAt: null }];

export const members: CanvasMember[] = [
  { person: ada, access: "owner", joined: true },
  { person: sam, access: "edit", joined: true },
  { person: maya, access: "edit", joined: true },
  { person: jordan, access: "edit", joined: true },
  { person: alex, access: "edit", joined: true },
];

/** Share with two people who have access on GitHub and haven't opened Ponzu yet. */
export const membersMixed: CanvasMember[] = [
  ...members.slice(0, 3),
  { person: ting, access: "edit", joined: false },
  { person: leo, access: "view", joined: false },
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

/**
 * What an account offers once Claude Code knows a model Ponzu has never heard of, as the API
 * answers it: the new one under Claude Code's own name, after the ones Ponzu knows, and no Fable
 * (this account isn't offered it). Haiku 5.5 takes only two efforts here, a long-named one
 * three, and Haiku 4.5 none.
 */
export const reportedModels: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: ["low", "medium"] },
  { id: "claude-opus-6", label: "Opus 6", efforts: ["low", "medium", "high", "xhigh", "max"] },
  // The longest name the API lets through is 40; this one is 39.
  {
    id: "claude-opus-6-1m",
    label: "Opus 6 with a million tokens of context",
    efforts: ["low", "medium", "high"],
  },
  // Claude Code says it takes none.
  { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [] },
];

const threeTakes = settled[1]!;
export const heroResults: SearchResults = {
  query: "hero",
  canvases: [
    { canvas: teamCanvases[0]!, matches: [[13, 17]] },
    { canvas: threeTakes, matches: [[19, 23]] },
  ],
  boards: [
    {
      id: "ab_hero_b",
      name: "Hero · B",
      matches: [[0, 4]],
      canvas: { id: quieter.id, name: quieter.name },
    },
    {
      id: "ab_hero_dark",
      name: "Hero, dark",
      matches: [[0, 4]],
      canvas: { id: brandKit.id, name: brandKit.name },
    },
  ],
  comments: [
    {
      id: "msg_serif",
      threadId: "th_serif",
      text: "Can C try the serif at a smaller size on the hero?",
      matches: [[44, 48]],
      author: maya,
      canvas: { id: quieter.id, name: quieter.name },
      at: minutesAgo(120),
    },
  ],
};
