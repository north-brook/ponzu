/*
 * The boards' threads, questions and pull request as the product's types, and the extra states
 * the boards don't draw.
 */
import type { Ask, Person, PullRequestDetail, ThreadItem, ThreadNotice } from "../model.ts";
import { bryce, maya, NOW, sam } from "./fixtures.ts";

const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

let seq = 0;
type Content = Omit<ThreadItem, "id" | "seq" | "at" | "streaming">;
function item(content: Content, streaming = false, minutesAgo = 5): ThreadItem {
  seq += 10;
  return { id: `ti_${seq}`, seq, at: at(minutesAgo), streaming, ...content } as ThreadItem;
}

export const said = (from: Person, text: string): ThreadItem =>
  item({ kind: "message", payload: { text, from, attachments: [] } });
export const reply = (text: string, streaming = false): ThreadItem =>
  item({ kind: "assistant", payload: { text } }, streaming);
export const work = (label: string, streaming: boolean, steps = 4, artboards: string[] = []) =>
  item({ kind: "tool", payload: { label, steps, artboards } }, streaming);
export const notice = (payload: ThreadNotice, streaming = false) =>
  item({ kind: "notice", payload }, streaming);
const comment = (from: Person, text: string, pin: { x: number; y: number }): ThreadItem =>
  item({
    kind: "comment",
    payload: {
      threadId: `th_${seq}`,
      messageId: `msg_${seq}`,
      text,
      artboardId: "ab_hero",
      artboardName: "Hero",
      from,
      pin,
    },
  });

const ASK = "Give me three takes on the hero. Keep the green.";
const READ =
  "I read the shop page and the current hero. B will be quieter and C editorial; A stays as it is.";

/** Board 1: you alone, the agent mid-run. */
export const heroThread: ThreadItem[] = [
  said(bryce, ASK),
  reply(READ),
  // The pin sits where the board draws it on its 132×72 frame.
  comment(bryce, "Too many words here. Calmer, and put a quieter take beside it.", {
    x: 57 / 132,
    y: 45 / 72,
  }),
  reply("Folding that into B: no paragraph, and the photo does the talking."),
  work("Writing Hero · B's headline", true),
];

/** Board 2: the same thread, the agent waiting on a question. */
export const askingThread: ThreadItem[] = heroThread.slice(0, 4);

/** Board 6: the moment after send. */
export const setUpThread: ThreadItem[] = [
  said(bryce, "I'd like to iterate on the onboarding flow"),
  reply("Rebuilding onboarding from the app's code. Light and Water are in."),
  work("Rebuilding Welcome · Picks", true),
];

/** Together on a design: three people steer one run. */
export const teamThread: ThreadItem[] = [
  said(bryce, ASK),
  comment(sam, "The photo should lead here, not the headline.", { x: 101 / 130, y: 41 / 81 }),
  reply("Making the photo lead in B for Sam, and keeping your headline in A so you can compare."),
  said(maya, "Can C try the serif at a smaller size?"),
  work("Cropping Hero · B's photo", true),
];

const headline = {
  header: "Headline",
  question: "The headline runs to three lines at 390px. Which way?",
  options: [
    { label: "Shorten it", description: "Cut to “Slow plants, fast homes.” Two lines on phones." },
    { label: "Smaller type on phones", description: "Drop to 30px under 420px; keeps the words." },
    { label: "Let it wrap", description: "Three lines, as the site does today." },
  ],
  multiSelect: false,
};
const crop = {
  header: "Photo",
  question: "Which takes should crop the photo tighter on phones?",
  options: [
    { label: "A", description: "The current hero." },
    { label: "B", description: "The quiet take." },
    { label: "C", description: "The editorial take." },
  ],
  multiSelect: true,
};

/** Board 2: two questions waiting, the headline first. */
export const boardAsks: Ask[] = [
  { id: "q_headline", status: "open", answeredBy: null, kind: "question", questions: [headline] },
  { id: "q_crop", status: "open", answeredBy: null, kind: "question", questions: [crop] },
];

/** One ask that holds both questions: the API takes their answers together. */
export const twoQuestionAsk: Ask = {
  id: "q_both",
  status: "open",
  answeredBy: null,
  kind: "question",
  questions: [headline, crop],
};

export const planAsk: Ask = {
  id: "q_plan",
  status: "open",
  answeredBy: null,
  kind: "plan",
  plan: "## Quieter hero\n\n1. Drop the paragraph from **B**; let the photo carry it.\n2. Set C's headline in Instrument Serif at `38px`.\n3. Add a `--hero-measure` token and use it in both.\n\nNothing changes in A. See the [brand site](https://fernwood.example/brand) for the serif.",
};

export const permissionAsk: Ask = {
  id: "q_permission",
  status: "open",
  answeredBy: null,
  kind: "permission",
  tool: "Bash",
  title: "Run the database migrations",
  description: "bun run db:migrate, against the sandbox's local Postgres.",
};

export const secretAsk: Ask = {
  id: "q_secret",
  status: "open",
  answeredBy: null,
  kind: "secret",
  name: "STRIPE_TEST_KEY",
  description: "The checkout page loads Stripe's test mode to draw the card form.",
};

export const linkAsk: Ask = {
  id: "q_link",
  status: "open",
  answeredBy: null,
  kind: "link",
  title: "Sign in to Figma so Claude can read the brand file",
  url: "https://www.figma.com/login",
  description: null,
};

/** A thread with something of every kind in it, for the states page. */
export const everyKind: ThreadItem[] = [
  notice({ type: "started" }),
  said(bryce, ASK),
  work("Reading the repo", false, 9),
  reply(
    "Here's what I found:\n\n- The hero lives in `src/components/hero.tsx`\n- Tokens are in `tokens.css`; there's no **measure** yet\n\nI'll start with B. See [the PR guide](https://ponzu.design/docs) for how I'll name the branch.",
  ),
  work("Drawing Hero · B", false, 6, ["ab_hero_b"]),
  notice({
    type: "question",
    questionId: "q_headline",
    header: "Headline",
    text: "The headline runs to three lines at 390px. Which way?",
  }),
  said(maya, "Can C try the serif at a smaller size?"),
  said(maya, "And keep the comma italic."),
  notice({ type: "stopped", by: sam }),
  notice({
    type: "error",
    code: "turn_failed",
    message: "Claude Code exited with status 1 while running `bun test`.",
  }),
  notice({ type: "error", code: "claude_limit", message: "" }),
  notice({
    type: "pull_request",
    number: 412,
    url: "https://github.com/north-brook/fernwood/pull/412",
    title: "Quieter hero, editorial take",
    state: "open",
  }),
  notice({
    type: "pull_request",
    number: 412,
    url: "https://github.com/north-brook/fernwood/pull/412",
    title: "Quieter hero, editorial take",
    state: "merged",
  }),
  reply("Merged. The design settles on its own.", true),
];

/**
 * A long thread, for scrolling: a thousand lines of people and the agent taking turns. Built
 * the same way every time, so a picture of it holds.
 */
export function longThread(count = 1000): ThreadItem[] {
  const people = [bryce, sam, maya];
  const items: ThreadItem[] = [];
  for (let i = 0; i < count; i++) {
    const turn = i % 4;
    const n = i + 1;
    const content: Content =
      turn === 0
        ? {
            kind: "message",
            payload: {
              text: `Pass ${n}: tighten the spacing on B.`,
              from: people[i % 3]!,
              attachments: [],
            },
          }
        : turn === 1
          ? {
              kind: "tool",
              payload: { label: `Drawing Hero · B, take ${n}`, steps: (i % 7) + 1, artboards: [] },
            }
          : turn === 2
            ? {
                kind: "assistant",
                payload: {
                  text: `Done with pass ${n - 2}. The headline now sits ${n % 9}px lower and the photo leads.`,
                },
              }
            : { kind: "assistant", payload: { text: `Line ${n}.` } };
    items.push({
      id: `ti_long_${n}`,
      seq: n,
      at: at(count - i),
      streaming: false,
      ...content,
    } as ThreadItem);
  }
  return items;
}

const check = (
  name: string,
  seconds: number | null,
  state: PullRequestDetail["checks"][number]["state"] = "passing",
  description: string | null = null,
) => ({
  id: `chk_${name}`,
  name,
  state,
  startedAt: seconds === null ? null : at(20),
  completedAt: seconds === null ? null : new Date(NOW - 20 * 60_000 + seconds * 1000).toISOString(),
  description,
  url: `https://github.com/north-brook/fernwood/pull/412/checks?name=${encodeURIComponent(name)}`,
});

const theo = { login: "theob", name: "Theo Barrett", avatarUrl: null, agent: false };

const HERO_PATCH = `@@ -13,6 +13,5 @@ export function Hero() {
 export function Hero() {
   return (
-    <h1 className="hero-title">Plants that outlive your lease</h1>
-    <p>Hardy, slow-growing greenery, potted and delivered.</p>
+    <h1 className="hero-title">Slow plants, fast homes</h1>
     <HeroPhoto crop="wide" />
   );`;

/** Board 3's pull request. */
export const pullRequest: PullRequestDetail = {
  number: 412,
  url: "https://github.com/north-brook/fernwood/pull/412",
  title: "Quieter hero, editorial take",
  body: "Drops the paragraph from the hero and lets the photo carry it. Headline set in Instrument Serif at 38px; tokens get a `--hero-measure`.",
  head: "pz/hero-refresh",
  base: "main",
  state: "open",
  endedAt: null,
  additions: 214,
  deletions: 38,
  checks: [
    check("ci / test", 161),
    check("ci / typecheck", 58),
    check("ci / lint", 21),
    check("ci / build", 72),
    check("ci / e2e", 185),
    check("Vercel preview", null, "passing", "Ready"),
    check("CodeQL", 93),
    check("commitlint", 9),
  ],
  comments: [
    {
      id: "c1",
      author: theo,
      body: "Love the line. Can the comma italic match the brand site?",
      at: at(14),
      path: "src/components/hero.tsx",
      line: 15,
      url: "https://github.com/north-brook/fernwood/pull/412#discussion_r1",
    },
    {
      id: "c2",
      author: { login: "ponzu-dev[bot]", name: null, avatarUrl: null, agent: true },
      body: "Done in 4e1c2a0: the comma now uses the italic from tokens.css.",
      at: at(12),
      path: null,
      line: null,
      url: "https://github.com/north-brook/fernwood/pull/412#issuecomment-2",
    },
    {
      id: "c3",
      author: { login: bryce.login, name: bryce.name, avatarUrl: bryce.avatarUrl, agent: false },
      body: "Ship it once e2e is green.",
      at: at(3),
      path: null,
      line: null,
      url: "https://github.com/north-brook/fernwood/pull/412#issuecomment-3",
    },
  ],
  reviews: [{ id: "r1", author: theo, state: "approved", at: at(12) }],
  files: [
    {
      path: "src/app/(shop)/page.tsx",
      previousPath: null,
      status: "modified",
      additions: 96,
      deletions: 21,
      patch: HERO_PATCH,
      binary: false,
    },
    {
      path: "src/components/hero.tsx",
      previousPath: null,
      status: "modified",
      additions: 74,
      deletions: 12,
      patch: HERO_PATCH,
      binary: false,
    },
    {
      path: "src/styles/tokens.css",
      previousPath: null,
      status: "modified",
      additions: 18,
      deletions: 3,
      patch: "@@ -1,3 +1,4 @@\n :root {\n+  --hero-measure: 38ch;\n   --ink: #111110;\n }",
      binary: false,
    },
    {
      path: "src/components/hero-photo.tsx",
      previousPath: null,
      status: "modified",
      additions: 26,
      deletions: 2,
      patch: HERO_PATCH,
      binary: false,
    },
  ],
};

/** What the tab draws when a pull request has more going on than board 3's. */
export const busyPullRequest: PullRequestDetail = {
  ...pullRequest,
  state: "draft",
  checks: [
    ...pullRequest.checks.slice(0, 3),
    check("ci / e2e", null, "failing"),
    check("ci / visual", null, "running"),
    check("deploy", null, "queued"),
    check("docs", null, "skipped"),
  ],
  reviews: [
    ...pullRequest.reviews,
    {
      id: "r2",
      author: { login: maya.login, name: maya.name, avatarUrl: maya.avatarUrl, agent: false },
      state: "changes_requested",
      at: at(4),
    },
  ],
  files: [
    ...pullRequest.files,
    {
      path: "public/hero.avif",
      previousPath: null,
      status: "added",
      additions: 0,
      deletions: 0,
      patch: null,
      binary: true,
    },
    {
      path: "src/generated/schema.ts",
      previousPath: null,
      status: "modified",
      additions: 1840,
      deletions: 922,
      patch: null,
      binary: false,
    },
    {
      path: "src/components/hero-copy.tsx",
      previousPath: "src/components/copy.tsx",
      status: "renamed",
      additions: 512,
      deletions: 3,
      patch: HERO_PATCH,
      binary: false,
    },
  ],
};
