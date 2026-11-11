import { type Artboard, type Doc, hashedId, parseArtboardFile, type Thread } from "@ponzu/core";

/*
 * What each agent case starts from, made up for the suite: a fitness app's repository and an
 * onboarding flow already on its canvas (as the first case would leave it), and a scratch
 * design with a pricing hero, its note and a phone version. Every case starts from one of these,
 * so no case depends on another's turn.
 */

/** The fitness app's repository: what `github.com/ada/fitness-app` holds on main. */
export const FITNESS_REPO: Record<string, string> = {
  "README.md": `# Cadence

Cadence builds a weekly training plan around the days you can actually train. Tell it your goal,
your experience and your schedule, and it gives you a week of sessions, adjusting as you log them.

The iPhone app is not built yet. This repository holds the product notes and, as they are made,
the design specs.
`,
  "docs/product.md": `# Product notes

- Audience: people getting back into training, 25 to 45, who have tried apps that assume five
  free evenings a week.
- The plan adapts: miss a session and the week rearranges.
- Business model: subscription with a free trial (not decided: trial length, a free tier).
- Reminders: one notification on a training day, never on a rest day.
`,
  "docs/onboarding/README.md": `# Onboarding spec

Seven iPhone screens, left to right on the canvas's Onboarding page.

1. Welcome
2. Goal
3. Experience
4. Schedule
5. Reminders
6. Building plan
7. Your plan

## Tokens

- paper #F6F2EA
- ink #16130F
- accent #FF5A1F (signal orange): the main button, the selected day, the plan label
- muted #6F6A62
- type: Inter Tight
`,
};

const TOKENS = `:root {
  --paper: #f6f2ea;
  --ink: #16130f;
  --accent: #ff5a1f;
  --muted: #6f6a62;
  --font: "Inter Tight", system-ui, sans-serif;
}
`;

const PHONE =
  "width: 390px; height: 844px; background: var(--paper); color: var(--ink); font-family: var(--font); display: flex; flex-direction: column; padding: 64px 24px 40px; gap: 16px; box-sizing: border-box";
const BUTTON =
  "margin-top: auto; background: var(--accent); color: #fff; border-radius: 14px; padding: 18px; text-align: center; font-weight: 600";
const OPTION =
  "border: 1px solid #d9d2c6; border-radius: 12px; padding: 14px 16px; display: flex; gap: 12px; align-items: center; font-size: 16px";

function board(name: string, html: string, x: number, y = 0, style = PHONE): Artboard {
  const id = hashedId("ab", `eval/${name}`);
  const { artboard } = parseArtboardFile(
    `<section data-artboard data-id="${id}" data-name="${name}" data-x="${x}" data-y="${y}" style="${style}">${html}</section>`,
    { id, name },
  );
  return artboard;
}

const step = (n: number) => `<p style="color: var(--muted); font-size: 13px">Step ${n} of 5</p>`;
const options = (labels: string[]) =>
  labels
    .map(
      (label) =>
        `<div style="${OPTION}"><span style="width: 20px; height: 20px; border: 1.5px solid var(--ink); border-radius: 4px"></span><span>${label}</span></div>`,
    )
    .join("");

/** The onboarding flow, seven screens and its note, on the Onboarding page. */
export function onboardingDoc(): Doc {
  const screens = [
    board(
      "1 Welcome",
      `<h1 style="font-size: 40px; line-height: 1.05; margin-top: 120px">Train to your own rhythm.</h1><p style="color: var(--muted)">A week of training built around the days you have.</p><div style="${BUTTON}">Get started</div><p style="text-align: center; font-size: 14px">I have an account</p>`,
      0,
    ),
    board(
      "2 Goal",
      `${step(1)}<h2 style="font-size: 28px">What are you training for?</h2><p style="color: var(--muted)">Pick what matters most.</p>${options(["Get stronger", "Run farther", "Lose weight", "Feel better day to day"])}<div style="${BUTTON}">Continue</div>`,
      440,
    ),
    board(
      "3 Experience",
      `${step(2)}<h2 style="font-size: 28px">How much have you trained?</h2>${options(["Brand new", "Some, a while ago", "Regularly", "Experienced"])}<div style="${BUTTON}">Continue</div>`,
      880,
    ),
    board(
      "4 Schedule",
      `${step(3)}<h2 style="font-size: 28px">Which days can you train?</h2><div style="display: flex; gap: 6px">${["M", "T", "W", "T", "F", "S", "S"].map((d, i) => `<span style="flex: 1; text-align: center; padding: 12px 0; border-radius: 10px; ${i % 2 === 0 ? "background: var(--accent); color: #fff" : "border: 1px solid #d9d2c6"}">${d}</span>`).join("")}</div><p style="color: var(--muted)">30 minutes a session</p><div style="${BUTTON}">Continue</div>`,
      1320,
    ),
    board(
      "5 Reminders",
      `${step(4)}<h2 style="font-size: 28px">A nudge on training days?</h2><p style="color: var(--muted)">One reminder on the days you train, never on rest days. Like "Upper body, 30 min" on Wednesday at 7:30.</p><div style="${BUTTON}">Turn on reminders</div><p style="text-align: center; font-size: 14px">Not now</p>`,
      1760,
    ),
    board(
      "6 Building plan",
      `<p style="margin-top: 260px; text-align: center; color: #f6f2ea">Building your week…</p>`,
      2200,
      0,
      `${PHONE}; background: var(--ink)`,
    ),
    board(
      "7 Your plan",
      `${step(5)}<p style="color: var(--accent); font-weight: 600; font-size: 13px">YOUR PLAN IS READY</p><h2 style="font-size: 28px">This week</h2><ul style="padding: 0; list-style: none; display: grid; gap: 8px"><li>Mon · Upper body · 30 min</li><li>Wed · Run · 25 min</li><li>Fri · Full body · 30 min</li><li>Sun · Mobility · 20 min</li></ul><div style="${BUTTON}">Start today's workout</div>`,
      2640,
    ),
  ];
  const note = board(
    "Note: How the flow works",
    `<h2>How the flow works</h2><p>Four questions (goal, experience, schedule, reminders), then the plan. Account creation is not designed yet; it is assumed to come after the plan.</p><p>Accent: signal orange (--accent), kept for the main button, the selected days and the plan label.</p><p>Open: where account creation goes; whether Apple Health is asked for.</p>`,
    0,
    940,
    "width: 760px; height: 360px; background: light-dark(#fffdf8, #1d1a16); color: light-dark(#16130f, #f6f2ea); font-family: var(--font); padding: 32px; box-sizing: border-box",
  );
  return {
    name: "Cadence onboarding",
    pages: [{ id: "pg_onboard", name: "Onboarding", artboards: [...screens, note] }],
    tokens: TOKENS,
    threads: [],
    notes: {},
  };
}

/** A comment pinned on a board: the thread the canvas would hold for it. */
export function pinnedComment(
  doc: Doc,
  { boardName, text }: { boardName: string; text: string },
): { doc: Doc; thread: Thread; artboard: Artboard | null } {
  const page = doc.pages[0]!;
  const artboard = page.artboards.find((a) => a.name === boardName) ?? null;
  const now = Date.parse("2026-11-11T12:00:00Z");
  const thread: Thread = {
    id: "th_evalpin",
    ...(artboard ? { artboardId: artboard.id } : { pageId: page.id }),
    x: artboard ? 195 : 1400,
    y: artboard ? 320 : -120,
    status: "open",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: "m_evalpin",
        author: { kind: "user", name: "Ada", id: "usr_ada" },
        text,
        createdAt: now,
      },
    ],
  };
  return { doc: { ...doc, threads: [...doc.threads, thread] }, thread, artboard };
}

/** A scratch design: a pricing hero and its note on Home, a phone version on Mobile. */
export function pricingDoc(): Doc {
  const plan = (name: string, price: string, featured = false) =>
    `<div style="flex: 1; border-radius: 16px; padding: 24px; ${featured ? "background: #2f6b5a; color: #fff" : "border: 1px solid #d6dbd7"}"><h3>${name}</h3><p style="font-size: 32px; font-weight: 600">${price}</p></div>`;
  const hero = board(
    "Pricing hero",
    `<h1 style="text-align: center">Find a calmer ten minutes a day</h1><div style="display: flex; gap: 24px">${plan("Monthly", "$12")}${plan("Yearly", "$6.67 / mo", true)}${plan("Lifetime", "$199")}</div>`,
    0,
    0,
    "width: 1200px; height: 640px; background: #f4f6f5; color: #18201d; font-family: system-ui; padding: 64px; display: flex; flex-direction: column; gap: 32px; box-sizing: border-box",
  );
  const note = board(
    "Note: Which plan to pick",
    `<h2>Which plan to pick</h2><table><tr><th></th><th>Monthly</th><th>Yearly</th><th>Lifetime</th></tr><tr><td>Price</td><td>$12/mo</td><td>$80/yr</td><td>$199</td></tr><tr><td>Break-even</td><td>n/a</td><td>7 months</td><td>17 months</td></tr></table><p>I'd lead with Yearly: a year gives a meditation habit time to take hold, and it costs 44% less than Monthly.</p>`,
    1260,
    0,
    "width: 760px; height: 520px; background: light-dark(#fffdf8, #1b1f1d); color: light-dark(#18201d, #eef2f0); font-family: system-ui; padding: 32px; box-sizing: border-box",
  );
  const mobile = board(
    "Yearly plan – mobile",
    `<h2>Find a calmer ten minutes a day</h2>${plan("Yearly", "$6.67 / mo", true)}<p style="font-size: 14px">Prefer another option? Monthly $12 · Lifetime $199</p>`,
    0,
    0,
    "width: 390px; height: 844px; background: #f4f6f5; color: #18201d; font-family: system-ui; padding: 48px 20px; display: flex; flex-direction: column; gap: 20px; box-sizing: border-box",
  );
  return {
    name: "Stillwater pricing",
    scratch: true,
    pages: [
      { id: "pg_home", name: "Home", artboards: [hero, note] },
      { id: "pg_mobile", name: "Mobile", artboards: [mobile] },
    ],
    tokens: ":root {\n}\n",
    threads: [],
    notes: {},
  };
}
