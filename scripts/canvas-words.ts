import { KEEP_AGENT } from "./canvas-words/keep-agent.ts";
import { KEEP_API } from "./canvas-words/keep-api.ts";
import { KEEP_APPS } from "./canvas-words/keep-apps.ts";
import { KEEP_DB } from "./canvas-words/keep-db.ts";
import { KEEP_DOCS } from "./canvas-words/keep-docs.ts";

// The design -> canvas rename: every rule in one place. The one-shot script (rename.ts) applies
// them; the committed test (scripts/canvas-words.test.ts) holds the tree to them afterwards, so
// what the script leaves alone and what the test allows are the same list.
//
// Matching is case-sensitive on purpose: "design", "Design" and "DESIGN" are the word, while
// "claudeSignIn" or "setClaudeSignInSession" only contain the letters case-insensitively.

/** A path glob (Bun.Glob syntax) with why it is out of scope. */
export interface PathRule {
  glob: string;
  why: string;
}

/** Spans never changed, wherever they are. Masked before any rule runs. */
export interface Protect {
  re: RegExp;
  why: string;
  /** Only in these paths (globs); everywhere when absent. */
  paths?: string[];
  /**
   * The script leaves the span to a person, but the completeness test does not allow it: the
   * hand change must happen (the ideas gate's own names).
   */
  scriptOnly?: true;
}

/** A whole line kept as it is: in `path` (a glob), any line containing `has`. */
export interface Keep {
  path: string;
  has: string;
  why: string;
}

/** An exact rename of a whole token, before the general rule. */
export interface Name {
  from: string;
  to: string;
  why: string;
  paths?: string[];
  /** Only where the word sits in a code position (a key, a member, a quoted or backticked value). */
  codeOnly?: true;
}

/** A phrase that marks a line's bare words as another sense: the line goes to a person. */
export interface Sense {
  re: RegExp;
  why: string;
  paths: string[];
}

// ---------------------------------------------------------------------------------------------
// 1. Paths the rename never touches (kind C, history, generated, image inputs).

export const EXCLUDE: PathRule[] = [
  { glob: "packages/server/**", why: "1.x local server (kind C)" },
  { glob: "packages/mcp/**", why: "1.x MCP (kind C)" },
  { glob: "packages/store/**", why: "1.x .design store (kind C)" },
  { glob: "apps/cli/**", why: "1.x CLI (kind C)" },
  { glob: "plugin/**", why: "1.x plugin (kind C)" },
  { glob: ".claude-plugin/**", why: "1.x marketplace manifest (kind C)" },
  { glob: "apps/mobile/**", why: "1.x phone app (kind C)" },
  { glob: "docs/mobile.md", why: "1.x phone app (kind C)" },
  { glob: "design/**", why: ".design folders (the format)" },
  { glob: "examples/**", why: ".design folders (the format)" },
  { glob: "apps/web/**", why: "the 1.x site; its cloud page is re-included below" },
  {
    glob: "packages/core/src/{link,github,catalog,suggestions,activity,journal,protocol,preview,types}.ts",
    why: "1.x local document modules",
  },
  { glob: "packages/core/src/{link,github,core,update}.test.ts", why: "tests of the 1.x modules" },
  { glob: "packages/tools/src/local/**", why: "the local server's tools (kind C)" },
  {
    glob: "packages/tools/src/guides.ts",
    why: "the local MCP's guides and SERVER_INSTRUCTIONS: only packages/mcp and local/ read them (kind C)",
  },
  { glob: "packages/db/migrations/**", why: "applied history; 0025 is written by hand" },
  { glob: "apps/*/evals/*/results/**", why: "recorded eval runs; the re-run regenerates them" },
  {
    glob: "apps/studio/src/cloud/gallery/references/**",
    why: "generated pictures; redrawn in the integration",
  },
  { glob: "apps/studio/src/cloud/styles/fonts/**", why: "font files and their licences" },
  { glob: "apps/web/fonts/**", why: "font licences" },
  { glob: "README.md", why: "the 1.x front page, until cutover" },
  { glob: "CHANGELOG.md", why: "release history" },
  { glob: "THIRD_PARTY_NOTICES.md", why: "third-party licences" },
  { glob: "apps/desktop/src/legacy*.ts", why: "1.x carry-over (~/Designs, design.json)" },
  { glob: "apps/desktop/build/{uninstall.ps1,README.md}", why: "1.x Windows ProgID cleanup" },
  { glob: "scripts/{npm-smoke,npm-package}.ts", why: "the 1.x npm package" },
  {
    glob: "apps/runner/image/{Dockerfile,provision.sh,pins.json}",
    why: "image inputs: an edit changes the image tag and recreates every sandbox",
  },
  { glob: "apps/runner/image/libexec/**", why: "image inputs" },
  {
    glob: "**/*.{png,jpg,jpeg,webp,gif,ico,icns,ttf,otf,woff,woff2,pdf,mp4,mov,zip,tar,gz}",
    why: "binary",
  },
  { glob: "bun.lock", why: "lockfile" },
  { glob: "scripts/canvas-words{.ts,.test.ts,/**}", why: "the rules name the word they rule on" },
];

/** Paths inside an excluded tree that the rename does cover. */
export const INCLUDE_AGAIN: PathRule[] = [
  { glob: "apps/web/app/designs/**", why: "the cloud canvas link page" },
  { glob: "apps/web/next.config.ts", why: "gets the /designs/:id redirect" },
];

/**
 * Paths where the script renames identifiers, keys, paths and SQL but leaves every bare word in
 * prose (comments, strings, Markdown) to a person: there "design" is mostly the activity (ideas
 * and their gate, eval inputs people really type) or another thing (the mockup, a spec).
 */
export const PROSE_BY_HAND: PathRule[] = [
  { glob: "apps/api/src/ideas/**", why: "ideas prompts and the gate: activity sense" },
  { glob: "apps/api/evals/**", why: "ideas evals: inputs people type, the gate's labels" },
  { glob: "apps/api/src/testing/fake-model.ts", why: "the gate's fake verdict" },
  { glob: "apps/api/src/routes/repo-ideas.test.ts", why: "gate criteria and idea inputs" },
  { glob: "apps/runner/evals/**", why: "agent evals: requests people type" },
  { glob: "packages/evals/**", why: "judge wording" },
  { glob: "scripts/evals.ts", why: "judge wording" },
  { glob: "docs/evals.md", why: "judge wording" },
  // "The design" here is the external "Ship with Ponzu" mockup the studio is built to, or the spec
  // a test checks against: it becomes "the mockup" or "the spec", never "the canvas".
  { glob: "apps/studio/src/cloud/styles/**", why: "the mockup's tokens and measures" },
  {
    glob: "apps/studio/src/cloud/ui/**",
    why: "components drawn to the mockup (and canvas links: by hand)",
  },
  { glob: "apps/studio/src/cloud/window/**", why: "the window as the mockup lays it out" },
  { glob: "apps/studio/src/app/panes.e2e.test.ts", why: "the mockup's pane widths" },
  { glob: "apps/studio/src/cloud/README.md", why: "the mockup and the canvas, side by side" },
  { glob: "apps/studio/scripts/**", why: "the mockup's .design folder" },
  { glob: "packages/sandbox/**", why: "the spec the sandbox follows" },
  { glob: "apps/runner/image/**", why: "the spec the image follows" },
  // "The design" here is mostly a board's own HTML and CSS (its corners, its transforms, the
  // animations it paused), while "canvas" already means the view: no prose rule can tell them.
  {
    glob: "packages/canvas/src/**",
    why: "a board's own HTML and CSS, beside the canvas as the view",
  },
];

// ---------------------------------------------------------------------------------------------
// 2. Spans never changed. Order does not matter: all are masked before anything is renamed.

export const PROTECT: Protect[] = [
  // The brand domain and its hosts. Only the host is masked, so the path after it
  // (https://ponzu.design/designs/<id>) is still renamed.
  { re: /[\w.-]*ponzu\.design\b/g, why: "the ponzu.design domain and its hosts" },
  {
    re: /\bdesign\.ponzu\.app(?:\.(?:dev|preview))?\b/g,
    why: "bundle ids (reverse DNS of the domain)",
  },
  { re: /\bPonzu\.Design\b/g, why: "the 1.x Windows ProgID" },
  // The .design file format: a file or folder name, never `identifier.design` member access.
  { re: /\bdesign\/(?=[\w-]+\.design)/g, why: "the repo's design/ folder" },
  { re: /(?<=[/\\]|%2F)[\w.-]*\.design\b/g, why: "a .design path" },
  { re: /(?<=["'`])[\w-]+\.design(?=["'`/])/g, why: "a quoted .design file name" },
  { re: /\b[\w-]+\.design(?=\/)/g, why: "a .design folder in a path (name.design/pages)" },
  {
    re: /(?<=^|[\s"'`(])\*?\.design\b(?![\w$(?!]|\.\w)/g,
    why: "the .design extension (never ?.design or a call)",
  },
  {
    re: /(?<=\$\{[^}`]*\})\.design\b(?![\w$(?!]|\.\w)/g,
    why: "the .design extension right after an interpolation (`/d/{key}.design` in a template)",
  },
  {
    re: /\b(?:brand|press-kit|components|seekle|halon|kettle|Kettle|weft|iphone|phone|stress|smoke|github-viewer|windows-linux|landing|every-seekle-screen|fernwood)\.design\b/g,
    why: "a named .design file",
  },
  { re: /\bdesign\\?\.json\b/g, why: "the 1.x document file (also as a regex source)" },
  // The verb, the discipline and third-party names.
  { re: /\bdesign[ _.-]?(?:system|systems|tokens?)\b/gi, why: "design system, design tokens" },
  { re: /\b[\w-]*design-system[\w-]*/g, why: "file names like maybe-design-system.css" },
  { re: /\bfrontend-design\b/g, why: "a skill's name" },
  { re: /\bgraphics-design\b/g, why: "the macOS app category (kept)" },
  { re: /\bcodesign\b/g, why: "Apple's tool" },
  { re: /\b(?:[Rr]e-?)design(?:s|ed|ing|er|ers)?\b/g, why: "redesign, the verb ideas start with" },
  // The activity. The script never turns it into "canvas", but outside the eval inputs the test
  // does not allow it either: the founder asked for less "designing", so each use is rewritten
  // toward making, building and shipping, or kept by a KEEP line that says why.
  {
    re: /\b(?:[Dd]esign|DESIGN)(?:er|ers|ing|ed|able|edly|ER|ERS|ING|ED)\b/g,
    why: "designer, designing, designed: the activity (rewrite it, or KEEP it with a reason)",
    scriptOnly: true,
  },
  {
    re: /\b(?:[Dd]esign|DESIGN)(?:er|ers|ing|ed|able|edly|ER|ERS|ING|ED)\b/g,
    why: "eval inputs and recorded briefs: what people really type and agents really wrote",
    paths: ["apps/api/evals/**", "apps/runner/evals/**", "apps/api/src/ideas/*.test.ts"],
  },
  { re: /\b2-where-do-you-design\b/g, why: "a board file name in the external mockup" },
  {
    re: /\(design-\)\?tokens|design\[-_\]\?system/g,
    why: "patterns for a repo's own theme files (design-tokens.json, design-system.css), not ours",
    paths: ["apps/api/src/ideas/snapshot.ts"],
  },
  {
    re: /(?<=\bboard: ")[^"]+(?=")/g,
    why: "a board file of the external mockup (visual.ts opens it by this name)",
    paths: ["apps/studio/src/cloud/gallery/**"],
  },
  { re: /\bponzu-design\b/g, why: "a GitHub login and the 1.x skill's name" },
  {
    re: /\b(?:designs-of-risky-things|contact-details-as-designs)\b/g,
    why: "gate example ids that key the recorded calibration",
    paths: ["apps/api/evals/ideas/**"],
  },
  // 1.x names that cloud code calls but does not own.
  {
    re: /\bOpenDesign\b|\bopen-design\b/g,
    why: "apps/web/app/local's 1.x component",
    paths: ["apps/web/app/designs/**"],
  },
  { re: /\bDesignMeta\b/g, why: "core's 1.x type", paths: ["packages/core/src/doc.ts"] },
  {
    re: /(?<![\w$])Design(?![\w$])/g,
    why: "@ponzu/store's Design (1.x), which the shared tools' tests open",
    paths: ["packages/tools/src/tools.test.ts"],
  },
  // The studio's visual scripts take the external mockup's .design folder.
  {
    re: /--design\b|\bvalues\.design\b|\bdesignDir\b|\bdesign(?=: \{ type)/g,
    why: "the .design folder option",
    paths: ["apps/studio/scripts/**"],
  },
];

/**
 * Lines kept word for word; each is also allowed by the completeness test. One file per slice
 * (scripts/canvas-words/keep-<slice>.ts), so slices that own disjoint files never edit the same one.
 */
export const KEEP: Keep[] = [...KEEP_DB, ...KEEP_API, ...KEEP_AGENT, ...KEEP_APPS, ...KEEP_DOCS];

/** Where the ideas gate's and the ideas judge's criterion is named. */
export const GATE_PATHS = [
  "apps/api/src/ideas/**",
  "apps/api/evals/ideas/**",
  "apps/api/src/testing/fake-model.ts",
  "apps/api/src/routes/repo-ideas.test.ts",
  "packages/evals/**",
  "docs/evals.md",
];

/**
 * Phrases where "the design" is the external "Ship with Ponzu" mockup the studio is drawn to,
 * outside the PROSE_BY_HAND paths. A line that matches keeps its bare words for a person.
 */
export const SENSES: Sense[] = [
  {
    re: /\b(?:as|beside) the design(?:'s|’s)?\b|\bthe design(?:'s|’s)? (?:boards?|bar|strip|rail|artboard|chrome|widths?|measures?|halo|spacing|sizes?|other)\b|\bdesign boards\b|\bin place of the design(?:'s|’s)\b|\bthe design (?:gives|sizes|draws|lays|pads|shows|has)\b/,
    why: "may be the external mockup (the mockup's widths, as the mockup draws it)",
    paths: ["apps/studio/**", "packages/canvas/**", "apps/desktop/**"],
  },
  {
    re: /\bnothing but a design\b|\bonly as designs\b|\ba design at all\b|\bnot a design\b|\bis a \*\*design\*\*|\bas a design\b|\bis design\b|\bdesign brief\b|\bstill design\b/,
    why: "the ideas gate's criterion in words (by hand, to its decided words)",
    paths: ["docs/**", "apps/api/**", "packages/evals/**", "scripts/evals.ts"],
  },
  {
    re: /\b[Tt]he design (?:paused|scales|declares|asks|wrote|gives)\b|\b(?:[Tt]he|[Aa]) design(?:'s|’s) own (?:rules|transforms|corners|radius|transitions|:hover|@font-face|face|animation-play-state)\b|\bsibling of the design\b|\bwhere the design is\b/,
    why: "a board's own HTML and CSS (the design's own transitions), not the canvas",
    paths: ["packages/render/**", "apps/studio/**", "packages/canvas/**"],
  },
  {
    // In the renderer "the canvas" is also the live view, and a board's own states,
    // transitions and faces are its HTML and CSS: "the canvas's own" would read as the view's.
    re: /\b(?:[Tt]he|[Aa]) design(?:'s|’s) (?:own|states?|transitions?)\b/,
    why: "a board's own CSS states, transitions and faces, beside the canvas as the view",
    paths: ["packages/render/**"],
  },
  {
    re: /\bthe notifications design\b/,
    why: "the notifications spec (its cap_80), not a canvas",
    paths: ["apps/api/src/notifications/**"],
  },
];

/** Exact renames of whole tokens, applied before the general rule. */
export const NAMES: Name[] = [
  // Collisions: a design-named thing whose general rename would read wrong.
  {
    from: "DesignCanvas",
    to: "BoardsView",
    why: "the studio's view of a canvas's boards (avoids CanvasCanvas)",
  },
  { from: "DesignSource", to: "CanvasOrigin", why: "CanvasSource is @ponzu/canvas's" },
  { from: "DesignEvent", to: "FeedEvent", why: "CanvasEvent reads as a pointer event" },
  { from: "designSpec", to: "sandboxSpec", why: "it is the sandbox's spec" },
  { from: "designAction", to: "sandboxAction", why: "it is the sandbox's step" },
  { from: "designedIn", to: "hasCanvasIn", why: "canvasedIn is not a word" },
  { from: "onDesign", to: "canvasShowing", why: "onCanvas reads as a handler" },
  { from: "designCorners", to: "ownCorners", why: "a board's own corners" },
  {
    from: "design",
    to: "own",
    why: "cornersCss's parameter: a board's own radii",
    paths: ["packages/canvas/src/corners.ts"],
    codeOnly: true,
  },
  // The ideas gate's criterion is renamed honestly, not to "canvas": it asks whether an idea is
  // something people see or do (docs/cloud.md, "Ideas"). Its meaning does not change. Only code
  // positions are scripted (keys, members, quoted and backticked criteria); the prompt's own
  // definition lines are prose and are rewritten by hand to the words in DECIDED.
  {
    from: "design",
    to: "visible",
    why: "the gate's and the ideas judge's criterion",
    paths: GATE_PATHS,
    codeOnly: true,
  },
  { from: "SAFE_DESIGN", to: "SAFE_VISIBLE", why: "the gate's examples", paths: GATE_PATHS },
  { from: "not_design", to: "not_visible", why: "the gate's retry code", paths: GATE_PATHS },
  { from: "notDesign", to: "notVisible", why: "the gate's fake verdict", paths: GATE_PATHS },
  {
    from: "DESIGN_PATH",
    to: "FOLDER_PATH",
    why: "a pattern for the .design folder's paths",
    paths: ["packages/tools/src/cloud/cloud.test.ts"],
  },
  // Ids.
  {
    from: '"des"',
    to: '"cnv"',
    why: "the new id prefix",
    paths: [
      "packages/db/src/ids.ts",
      "packages/db/src/ids.test.ts",
      "packages/db/src/queries/designs.ts",
    ],
  },
  {
    from: '"dsn"',
    to: '"cnv"',
    why: "fixture id prefix",
    paths: ["packages/client/src/testing/backend.ts", "apps/studio/src/cloud/status.test.ts"],
  },
];

// ---------------------------------------------------------------------------------------------
// 3. The general rule's words.

/** The case maps, longest first. Inside identifiers they apply as substrings. */
export const CASES: [string, string][] = [
  ["Designs", "Canvases"],
  ["designs", "canvases"],
  ["DESIGNS", "CANVASES"],
  ["Design", "Canvas"],
  ["design", "canvas"],
  ["DESIGN", "CANVAS"],
];

const DETERMINERS =
  "a|an|the|this|that|these|those|each|every|its|one|another|new|your|their|our|my|his|her|no|any|which|whose|same|other|own|whole|scratch|repo|first|next|last|old|existing|shared|team|per|single|many|few|several|some|all|both|two|three|four|more|most|such|what|empty|fresh|settled|active|deleted|chosen|selected|current|given|unseen|private|public|untitled|named|open|opened|made|sent|starting|working";

/** A bare word right after one of these is the noun: rename it. */
export const NOUN_BEFORE = new RegExp(`(?:\\b(?:${DETERMINERS})|[\\w-]+'s|’s)\\s+$`, "i");
/** Before these the bare word is the verb or the activity: hand. */
export const VERB_BEFORE =
  /\b(?:to|you|we|they|i|can|can't|cannot|could|would|will|should|may|might|must|who|where|how|people|and|or|then|let's|lets|help|helps|start|starts|begin|begins|ever|never|also|still|just|not|in|of|for|about|at|into|like|than|good|great|better|ui|ux|product|visual|web|graphic|interface|interaction|motion|brand)\s+$/i;
/** After these the singular is a verb taking an object: hand. */
export const VERB_AFTER =
  /^\s+(?:a|an|the|this|that|these|those|my|our|your|their|some|something|anything|me|us|it|them|for|with|around|from)\b/i;
/** The activity as a modifier ("a design tool"): hand. */
export const ACTIVITY_AFTER =
  /^\s+(?:tool|tools|agent|agents|canvas|request|requests|change|changes|work|spec|specs|language|review|reviews|team|teams|sense|decisions?|direction|feedback|skills?|apps?|software|mockups?|files?|folders?|process|partner|briefs?|thinking|choices?|quality|intent|critique|principles?|problems?|tasks?|ideas?|discipline|world|perspective|eye|taste|reasoning|session)\b/i;
/** A subject before a plural "designs" makes it a verb ("it designs"): hand. */
export const SUBJECT_BEFORE =
  /\b(?:it|he|she|who|that|which|agent|claude|ponzu|one|someone|everyone)\s+$/i;

/** What a bad substitution leaves. A line that shows one is put back and sent to hand. */
export const ARTIFACTS =
  /canvas(?:'s|’s)? canvas|[Cc]anvas[Cc]anvas|canvas_canvas|canvases? canvas\b|[Cc]anvas(?:er|ers|ing|ed|able)\b|[Rr]ecanvas|cocanvas|ponzu\.canvas|canvas\.ponzu|\ban canvas|\b(?:to|you|we|they|can|could|would|will|should|where) canvas\b|["'`]Canvas (?:a|an|the|some)\b|canvas (?:a|an|the) (?:screen|page|flow|hero)|\/canvas\/canvas/;

/**
 * The completeness test's allowances: substrings blanked from a line before it is checked
 * again for the word. Never a whole-line pass, and never a span left only for a person.
 */
export const ALLOWED_SPANS: Protect[] = PROTECT.filter((p) => !p.scriptOnly);

/** Ids: fixture and test ids say cnv_ (existing des_ rows are kept in the database). */
export const ID_RE = /(?<![\w])(?:des|dsn)_(?=[A-Za-z0-9$[])/g;
/** An id prefix named in prose ("`des_…`"): the words need a person (old ids stay des_). */
export const ID_PROSE_RE = /(?<![\w])(?:des|dsn)_(?:…|\.\.\.|\*|`)/;
