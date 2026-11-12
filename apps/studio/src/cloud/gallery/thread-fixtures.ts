/*
 * The boards' threads, questions and pull request as the product's types, and the extra states
 * the boards don't draw.
 */
import type {
  AgentActivity,
  Ask,
  CommentPicture,
  Person,
  PullRequestDetail,
  ThreadItem,
  ThreadNotice,
  TurnRecord,
} from "../model.ts";
import { bryce, maya, NOW, sam } from "./fixtures.ts";
import heroCommentDark from "./previews/comment-hero-dark.webp";
import heroCommentLight from "./previews/comment-hero-light.webp";
import heroPreview from "./previews/hero.png";

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
/** A stretch of work as a runner before turn records wrote it. */
export const work = (label: string, streaming: boolean, steps = 4, artboards: string[] = []) =>
  item({ kind: "tool", payload: { label, steps, artboards } }, streaming);
export const notice = (payload: ThreadNotice, streaming = false) =>
  item({ kind: "notice", payload }, streaming);

/**
 * A turn's work item, as a runner that keeps one per turn writes it: streaming while the turn
 * runs. `steps` is its record's log, as [after, text, count]: `after` is a reply of the turn's,
 * or null before its first; `final`, set once the turn has ended, the reply that answers.
 */
export function turn(
  streaming: boolean,
  record: Partial<Omit<TurnRecord, "log">> & {
    steps?: [ThreadItem | null, string | null, number][];
  } = {},
): ThreadItem {
  const { steps = [], ...rest } = record;
  const log = steps.map(([after, text, count]) => ({ after: after?.id ?? null, text, count }));
  return item(
    {
      kind: "tool",
      payload: {
        label: "Thinking",
        steps: log.reduce((n, g) => n + g.count, 0),
        artboards: [],
        turn: { ended: null, ms: 0, final: null, boards: 0, files: 0, log, ...rest },
      },
    },
    streaming,
  );
}

/** Ends a turn: its record names its answer and how it ended. */
export function ended(
  open: ThreadItem,
  record: Partial<Omit<TurnRecord, "log">> & {
    steps?: [ThreadItem | null, string | null, number][];
  },
): ThreadItem {
  if (open.kind !== "tool" || !open.payload.turn) return open;
  const { steps, ...rest } = record;
  const log = steps
    ? steps.map(([after, text, count]) => ({ after: after?.id ?? null, text, count }))
    : open.payload.turn.log;
  return {
    ...open,
    streaming: false,
    payload: {
      ...open.payload,
      steps: log.reduce((n, g) => n + g.count, 0),
      turn: { ...open.payload.turn, ended: "done", ...rest, log },
    },
  };
}

/** The picture the app drew of a comment on the boards' "Hero", by the headline. */
export const heroPicture: CommentPicture = {
  kind: "image",
  light: heroCommentLight,
  dark: heroCommentDark,
  width: 240,
  height: 160,
};

export const comment = (
  from: Person,
  text: string,
  picture: CommentPicture | null = heroPicture,
  where: { artboardName: string | null; pageName?: string } = { artboardName: "Hero" },
): ThreadItem =>
  item({
    kind: "comment",
    payload: {
      threadId: `th_${seq}`,
      messageId: `msg_${seq}`,
      text,
      artboardId: where.artboardName ? "ab_hero" : null,
      artboardName: where.artboardName,
      pageName: where.pageName ?? null,
      from,
      picture,
    },
  });

const ASK = "Give me three takes on the hero. Keep the green.";
const READ =
  "I read the shop page and the current hero. B will be quieter and C editorial; A stays as it is.";

const readTurn = turn(false);
const readReply = reply(READ);
const heroTurn = turn(true);

/** Board 1: you alone, the agent mid-run. */
export const heroThread: ThreadItem[] = [
  said(bryce, ASK),
  // A turn that was only its answer.
  ended(readTurn, { final: readReply.id }),
  readReply,
  comment(bryce, "Too many words here. Calmer, and put a quieter take beside it."),
  heroTurn,
  reply("Folding that into B: no paragraph, and the photo does the talking."),
];
/** What board 1's agent is doing: its working state, from the canvas's head. */
export const heroAgent: AgentActivity = {
  state: "working",
  status: "Writing Hero · B's headline",
};

/** Board 2: the same thread, the agent waiting on a question. */
export const askingThread: ThreadItem[] = heroThread;

/** Board 6: the moment after send. */
export const setUpThread: ThreadItem[] = [
  said(bryce, "I'd like to iterate on the onboarding flow"),
  turn(true),
  reply("Rebuilding onboarding from the app's code. Light and Water are in."),
];
export const setUpAgent: AgentActivity = { state: "working", status: "Rebuilding Welcome · Picks" };

/** Together on a canvas: three people steer one run. */
export const teamThread: ThreadItem[] = [
  said(bryce, ASK),
  comment(sam, "The photo should lead here, not the headline."),
  turn(true),
  reply("Making the photo lead in B for Sam, and keeping your headline in A so you can compare."),
  said(maya, "Can C try the serif at a smaller size?"),
];
export const teamAgent: AgentActivity = { state: "working", status: "Cropping Hero · B's photo" };

/*
 * The founder's onboarding flow, a long turn: the agent says what it is on as it goes (asides,
 * with Markdown in them), and once it ends only its answer stays.
 */
const FLOW_ASK = "Build the onboarding flow for the running app, seven screens.";
const flowSaid = [
  "Copied the screen layout to steps 3–5. Now I'm filling in **3 · Experience**.",
  'Now "4 · About you": age, height and weight, with a ruler picker (`WeightRuler`) for weight.',
  'Now "5 · Schedule":\n\n- training days\n- session length\n- time of day',
  "Next is [1 · Welcome](https://ponzu.design/canvases/cnv_quieter?artboard=ab_welcome), a dark intro screen.",
];
const flowFinal =
  "The flow is ready: seven screens from **Welcome** to **Plan ready**, sharing one layout and the app's tokens. The weight picker is a ruler; *Plan ready* summarises the plan with week 1's sessions.";

function flowTurn(open: boolean) {
  const start = turn(open);
  const replies = flowSaid.map((text) => reply(text));
  const steps: [ThreadItem | null, string, number][] = [
    [null, "Read the canvas", 1],
    [null, "Read src/screens/Onboarding.tsx", 1],
    [null, 'Drew "3 · Experience"', 1],
    [null, 'Copied "3 · Experience"', 2],
    [replies[0]!, 'Wrote the copy for "3 · Experience"', 3],
    [replies[0]!, 'Took a screenshot of "3 · Experience"', 1],
    [replies[1]!, 'Drew "4 · About you"', 2],
    [replies[1]!, 'Restyled "4 · About you"', 4],
    [replies[1]!, "Edited styles/tokens.css", 1],
    [replies[2]!, 'Drew "5 · Schedule"', 1],
    [replies[2]!, 'Took a screenshot of "5 · Schedule"', 1],
    [replies[3]!, 'Drew "1 · Welcome"', 2],
    [replies[3]!, 'Committed "Onboarding flow"', 1],
  ];
  return { start, replies, steps };
}

/** A long turn running: its messages so far, no work lines, the working state at the foot. */
export const runningTurn: ThreadItem[] = (() => {
  const { start, replies } = flowTurn(true);
  return [said(bryce, FLOW_ASK), start, ...replies];
})();

/** The same turn, ended: only its answer stays. */
export const completedTurn: ThreadItem[] = (() => {
  const { start, replies, steps } = flowTurn(false);
  const final = reply(flowFinal);
  return [
    said(bryce, FLOW_ASK),
    ended(start, { final: final.id, ms: 252_000, boards: 7, files: 1, steps }),
    ...replies,
    final,
  ];
})();

/** Stopped mid-work: no answer to keep; the stop is its ending. */
export const stoppedTurn: ThreadItem[] = (() => {
  const start = turn(false);
  const first = reply("Starting with the pricing cards: three tiers, Pro in the middle.");
  return [
    said(bryce, "Three pricing cards, Pro in the middle."),
    ended(start, {
      ended: "stopped",
      ms: 48_000,
      boards: 1,
      steps: [
        [null, "Read the canvas", 1],
        [first, 'Drew "Pricing"', 1],
        [first, 'Restyled "Pricing"', 2],
      ],
    }),
    first,
    notice({ type: "stopped", by: bryce }),
  ];
})();

/** Failed: nothing it said on the way stays; the error says what happened. */
export const failedTurn: ThreadItem[] = (() => {
  const start = turn(false);
  const first = reply("Running the app to see the current checkout.");
  return [
    said(bryce, "Make the checkout one page."),
    ended(start, {
      ended: "failed",
      ms: 95_000,
      files: 2,
      steps: [
        [null, "Read src/app/checkout/page.tsx", 1],
        [first, "Installed packages", 1],
        [first, "Ran the dev server", 1],
        [first, "Edited src/app/checkout/page.tsx", 2],
        [first, "Edited …/checkout/Summary.tsx", 1],
      ],
    }),
    first,
    notice({
      type: "error",
      code: "turn_failed",
      message: "Claude's API answered 529: overloaded.",
    }),
  ];
})();

/** Ended on a question: its answer, then the question, which is how it ended. */
export const askedTurn: ThreadItem[] = (() => {
  const start = turn(false);
  const first = reply("I drew two takes on the hero.");
  const final = reply("Both are on the canvas. One thing before I go on:");
  return [
    said(bryce, ASK),
    ended(start, {
      final: final.id,
      ms: 70_000,
      boards: 2,
      steps: [
        [null, "Read the canvas", 1],
        [first, 'Drew "Hero · B"', 1],
        [first, 'Drew "Hero · C"', 1],
      ],
    }),
    first,
    final,
    notice({
      type: "question",
      questionId: "q_ended",
      header: "Headline",
      text: "The headline runs to three lines at 390px. Which way?",
      answer: "Shorten it",
    }),
  ];
})();

/** What the founder's thread held: an older runner's stretches, all "Setting direction". */
export const oldFormatThread: ThreadItem[] = (
  [
    said(bryce, FLOW_ASK),
    work("Setting direction", false, 10, ["ab_3"]),
    reply(flowSaid[0]!),
    work("Setting direction", false, 2, ["ab_3"]),
    work("Setting direction", false, 3, ["ab_4"]),
    reply(flowSaid[1]!),
    work("Setting direction", false, 2, ["ab_4"]),
    reply(flowSaid[2]!),
    work("Setting direction", false, 1, ["ab_5"]),
    reply(flowFinal),
  ] as ThreadItem[]
).map((entry, i) => ({ ...entry, at: at(14 - i * 1.3) }));

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
  reply("Merged. The canvas settles on its own.", true),
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
              // Now and then a picture, to read past while it loads.
              attachments:
                i % 40 === 0
                  ? [{ ref: "assets/hero.png", url: heroPreview, contentType: "image/png" }]
                  : [],
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
  headSha: "4e1c2a0f9b3d7e6c5a4b3c2d1e0f9a8b7c6d5e4f",
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
  checksComplete: true,
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
      diff: { kind: "text", patch: HERO_PATCH },
    },
    {
      path: "src/components/hero.tsx",
      previousPath: null,
      status: "modified",
      additions: 74,
      deletions: 12,
      diff: { kind: "text", patch: HERO_PATCH },
    },
    {
      path: "src/styles/tokens.css",
      previousPath: null,
      status: "modified",
      additions: 18,
      deletions: 3,
      diff: {
        kind: "text",
        patch: "@@ -1,3 +1,4 @@\n :root {\n+  --hero-measure: 38ch;\n   --ink: #111110;\n }",
      },
    },
    {
      path: "src/components/hero-photo.tsx",
      previousPath: null,
      status: "modified",
      additions: 26,
      deletions: 2,
      diff: { kind: "text", patch: HERO_PATCH },
    },
  ],
  filesTotal: 4,
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
      diff: { kind: "binary" },
    },
    {
      path: "src/generated/schema.ts",
      previousPath: null,
      status: "modified",
      additions: 1840,
      deletions: 922,
      diff: { kind: "too_large" },
    },
    {
      path: "src/components/hero-copy.tsx",
      previousPath: "src/components/copy.tsx",
      status: "renamed",
      additions: 512,
      deletions: 3,
      diff: { kind: "text", patch: HERO_PATCH },
    },
  ],
  filesTotal: 7,
};
