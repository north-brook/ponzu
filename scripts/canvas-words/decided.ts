// The words already decided for the rename (the plan's section 6), held as text so a slice can't
// leave the script's guess in place ("Describe the canvas") or skip a line the completeness test
// can't see once it no longer says design. Owned by the integrator; a slice that finds an entry
// that no longer fits its file writes a note instead of editing it.
//
// Each entry: in every file `path` matches, `gone` matches no line; and the files together hold
// each `present` string. Keep both short and specific.
export interface Decided {
  /** Who makes it true: a slice, or the integrator ("I", after the references are redrawn). */
  slice: "S1" | "S2" | "S3" | "S4" | "S5" | "I";
  path: string;
  /** Paths `path` matches that this entry leaves out. */
  except?: string;
  gone?: RegExp;
  present?: string[];
  why: string;
}

/** The visible words the founder asked to move away from, and the script's guesses at them. */
const OLD_VISIBLE =
  /Where do you design|where they design|Start designing|does the designing|Design on a canvas, steer|Design on your real product|Describe the (?:design|canvas)\b|Choosing the (?:design|canvas)(?:'s|’s)? icon|New design\b|By design\b/;

export const DECIDED: Decided[] = [
  // The words people read (6.2). Visible words and the tests that look for them change together.
  {
    slice: "S4",
    path: "apps/studio/src/cloud/setup/where.tsx",
    gone: /Where do you design|Design on your real product/,
    present: [
      'title="Where do you build?"',
      "Build on your real product, with your team, and ship it as a pull request.",
    ],
    why: "the setup step's title and body",
  },
  {
    slice: "S4",
    path: "apps/studio/{src,scripts}/**",
    except: "apps/studio/src/cloud/gallery/references/**",
    gone: OLD_VISIBLE,
    why: "the old visible words, in the app and every test that looks for them",
  },
  {
    slice: "I",
    path: "apps/studio/src/cloud/gallery/references/**",
    gone: OLD_VISIBLE,
    why: "the reference pictures' text, redrawn in phase 3",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/setup/iphone-step.tsx",
    present: ["Start building"],
    why: "the iPhone step's button",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/setup/claude-step.tsx",
    present: ["Claude Code does the work, in the cloud, on your own plan."],
    why: "the Connect Claude step",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/dialogs/account-dialogs.tsx",
    present: ["Claude Code does the work, on your own plan."],
    why: "the signed-out dialog",
  },
  {
    slice: "S4",
    path: "apps/studio/src/app/confirm-dialogs.tsx",
    gone: /Its canvas and thread go/,
    present: [
      "The canvas and its thread go, for everyone. Its branch and pull request on GitHub stay.",
    ],
    why: "the Delete canvas dialog, whose title already names the canvas (6.1)",
  },
  {
    slice: "S5",
    path: "{docs/analytics.md,apps/api/src/analytics/events.ts}",
    gone: /other than a canvas\b|are not canvases/,
    present: ["something other than work on the canvas"],
    why: "the ideas gate's words: its criterion is visible, and unsafe is anything but work on the canvas",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/README.md",
    gone: /compare --canvas/,
    present: ["bun scripts/visual.ts compare --design <path to the .design folder>"],
    why: "visual.ts takes the mockup's .design folder as --design",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/setup/sign-in.tsx",
    present: ["Build on a canvas, steer with comments, and ship pull requests to your repos."],
    why: "the sign-in line",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/settings/environments.tsx",
    gone: /design in it/,
    present: ["Ponzu sets a repo up the first time you start a canvas in it."],
    why: "Settings › Environments, empty",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/thread/thread.ts",
    gone: /safe in the (?:design|canvas)\b/,
    present: ["The commits are safe in Ponzu."],
    why: "push_failed",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/create/composer.tsx",
    present: ['aria-label="Describe what you want to make"'],
    why: "the composer has one name, the placeholder's (decided words)",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/settings/plan.tsx",
    gone: /By design|by design/,
    present: ['aria-label="By canvas"'],
    why: "Settings › Plan and usage",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/sidebar/sidebar.tsx",
    present: ['label="New canvas"'],
    why: "the founder's ask: New design -> New canvas",
  },
  {
    slice: "S4",
    path: "apps/desktop/src/menu.ts",
    gone: /New Design/,
    present: ['label: "New Canvas"'],
    why: "the File menu",
  },
  {
    slice: "S4",
    path: "apps/desktop/{package.json,src/linux.ts}",
    gone: /Design with Claude/,
    present: ["Build with Claude on a canvas, and ship pull requests"],
    why: "the Linux package's synopsis and .desktop Comment",
  },
  {
    slice: "S4",
    path: "apps/studio/src/app/pull-request-map.ts",
    present: ["^(?:Made|Designed) in Ponzu: "],
    why: "strips the new footer and the one on pull requests already on GitHub",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/ui/canvas-address.ts",
    present: ["(?:canvases|designs)"],
    why: "the old address is still read",
  },
  {
    slice: "S4",
    path: "apps/web/next.config.ts",
    present: ['source: "/designs/:id"', 'destination: "/canvases/:id"', "permanent: true"],
    why: "the old link redirects for good",
  },
  {
    slice: "S4",
    path: "apps/web/app/canvases/[[]id]/page.tsx",
    gone: /Open a design in Ponzu/,
    present: ['"Open a canvas in Ponzu."'],
    why: "the link page's description",
  },
  {
    slice: "S4",
    path: "apps/desktop/src/deep-links.test.ts",
    present: ["ponzu://canvas/cnv_", "ponzu://design/des_"],
    why: "both forms open, and an id from before the rename (des_) still does",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/ui/*.test.ts*",
    present: ["/canvases/cnv_", "/designs/des_"],
    why: "both addresses are read, with an id from before the rename",
  },
  {
    slice: "S4",
    path: "apps/studio/src/app/thread-links.e2e.test.ts",
    gone: /"ponzu\.design\/des"/,
    present: ['"ponzu.design/can"'],
    why: "a half address of the kind the app now writes (/canvases/) never shows while streaming",
  },
  {
    slice: "S4",
    path: "apps/studio/src/cloud/ui/place-link.test.tsx",
    gone: /ponzu\.design\/des"/,
    present: ['https://ponzu.design/can"'],
    why: "a half address of the kind the app now writes (/canvases/) is never drawn",
  },
  // A board's own HTML and CSS is not the canvas: there "canvas" is the view.
  {
    slice: "S4",
    path: "packages/canvas/**",
    gone: /\bthe canvas (?:paused|scales)\b|\bthe canvas(?:'s|’s) own (?:transforms|rules|corners|radius|transitions|face|@font-face|animation-play-state)\b|\bsibling of the canvas\b/i,
    why: "a board's own corners, transforms and paused animations are the board's, not the view's",
  },
  {
    slice: "S3",
    path: "packages/render/**",
    gone: /\bthe canvas (?:paused|scales|declares|asks|gives)\b|\bthe canvas(?:'s|’s) (?:own|states?|transitions?)\b|\bwhere the canvas is\b/i,
    why: "a board's own states, transitions and faces are its HTML and CSS, not the view's",
  },
  // The API (6.2, 6.3).
  {
    slice: "S2",
    path: "apps/api/src/notifications/kinds.test.ts",
    present: ['"des_7k2m9x4q0c8v5n1t"', '"cnv_7k2m9x4q0c8v5n1t"'],
    why: "ids from before and after the rename",
  },
  {
    slice: "S2",
    path: "apps/api/src/pull-requests/open.ts",
    gone: /Designed in Ponzu/,
    present: ["parts.push(`Made in Ponzu: ["],
    why: "the pull request footer (decided)",
  },
  {
    slice: "S2",
    path: "apps/api/src/ideas/gate.ts",
    gone: /a design tool|a design agent|nothing but a design|a designer|ask for a design|judge it a design|not a design\b/,
    present: [
      "before Ponzu shows them to a person",
      "asks the reader for nothing but work on the canvas.",
      "visible: true when it is something people see or do in the product that could be shown on a canvas:",
      "none of that makes it unsafe or not visible.",
    ],
    why: "the gate keeps its meaning; only its words change",
  },
  {
    slice: "S2",
    path: "apps/api/src/ideas/prompt.ts",
    gone: /a design tool|a designer|Can be designed|designs something new|begin designing|to design on|nothing but a design|something other than a design|into designs:/,
    present: [
      "the prompt box of Ponzu, a canvas where an agent builds with them",
      "someone building the product would actually type",
      "- Can be made on a canvas: what people see and do.",
      "no Ponzu (the tool they are shown in)",
      "Write the way someone briefs a colleague",
      "it makes something new.",
      "an idea was not something people see or do. Keep each to what people see and do",
    ],
    why: "the ideas writer's framing",
  },
  {
    slice: "S2",
    path: "apps/api/evals/ideas/judge.ts",
    gone: /a design tool|a design agent|nothing but a design|a designer|- design:|is design\b|it designs\b/,
    present: [
      "- visible: it is a brief someone could act on with a canvas:",
      "Pass when it makes something new",
    ],
    why: "the ideas judge grades the same criterion the gate checks",
  },
  {
    slice: "S2",
    path: "apps/api/src/notifications/kinds.ts",
    gone: /\bthe notifications (?:design|canvas)\b/,
    why: "the notifications spec's cap_80, not a canvas",
  },
  {
    slice: "S2",
    path: "apps/api/.env.example",
    gone: /Where design files/,
    present: ["Where a canvas's files are served from"],
    why: "ASSETS_URL",
  },
  // The agent (6.1, 6.2).
  {
    slice: "S3",
    path: "packages/tools/src/cloud/guides.ts",
    gone: /Ponzu is a (?:design|canvas) canvas|This (?:design|canvas) is a canvas/,
    present: [
      "Ponzu is a canvas you drive with HTML and CSS. This sandbox works on one canvas, shared live with everyone who has it open",
      "A canvas is pages of artboards",
    ],
    why: "the cloud agent's instructions and basics guide",
  },
  {
    slice: "S3",
    path: "packages/tools/src/cloud/tools.ts",
    gone: /being designed/,
    present: ['a few words for what is being made, like "Checkout flow"'],
    why: "update_canvas's description",
  },
  {
    slice: "S3",
    path: "packages/tools/src/listen.ts",
    gone: /designing in Ponzu/,
    present: ["House rules and workflows for work in Ponzu."],
    why: "get_guide's description, which the cloud agent reads",
  },
  {
    slice: "S3",
    path: "apps/runner/src/run.ts",
    gone: /asked for a design change|being designed|took over this design/,
    present: [
      "someone who asked for a change hasn't asked for it to land",
      'for what is being made, like "Quieter shop hero"',
      "Another runner took over this canvas",
    ],
    why: "the runner's instructions and its fatal line",
  },
  {
    slice: "S3",
    path: "apps/runner/src/steps.ts",
    gone: /Choosing the (?:design|canvas)(?:'s|’s)? icon|Setting the (?:design|canvas)(?:'s|’s)? tokens/,
    present: ['"Choosing an icon"', '"Setting the tokens"', "Naming the canvas"],
    why: "the steps people watch in the thread",
  },
  {
    slice: "S3",
    path: "apps/runner/evals/agent/judge.ts",
    gone: /a design agent wrote in the chat thread of a design tool/,
    present: ["You grade what an agent wrote in the chat thread beside a live canvas in Ponzu"],
    why: "the thread judge",
  },
  // The specification (6.1).
  {
    slice: "S5",
    path: "docs/cloud.md",
    gone: /The database is the design|whether it is a \*\*design\*\*|nothing but a (?:design|canvas)\b|only as (?:designs|canvases)\b/,
    present: [
      "**The database is the canvas.**",
      "whether it is **visible** (something people see or do)",
    ],
    why: "the specification's first principle, and the gate's criterion as the spec names it",
  },
];
