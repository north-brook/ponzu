import { PAGE_ICON_GROUPS } from "@ponzu/core";
import { LAYOUT_GUIDE, MOBILE_GUIDE, MOTION_GUIDE, TYPOGRAPHY_GUIDE } from "./craft.ts";
import { ACT_GUIDE, KIT_GUIDE, PRODUCT_GUIDE } from "./product.ts";

/** The icons a file or page can carry, a line per group. */
const ICON_LIST = Object.entries(PAGE_ICON_GROUPS)
  .map(([group, names]) => `  ${group}: ${names.join(", ")}`)
  .join("\n");

/** The files the format guide shows, one small design. Tests load them as written. */
export const FORMAT_EXAMPLE = {
  "design.json": `{
  "ponzu": 1,
  "name": "Checkout",
  "pages": [{ "id": "pg_flow", "name": "Flow", "icon": "flow" }]
}`,
  "pages/flow/cart.html": `<section data-artboard data-id="ab_cart" data-name="Cart" data-x="0" data-y="0" style="width:390px;height:844px;background-color:var(--color-paper)">
  <h1 data-id="n_title" data-name="Title" style="font:600 28px/1.1 var(--font-text)">Your cart</h1>
</section>`,
  "comments.json": `{
  "threads": [
    {
      "id": "th_title",
      "artboardId": "ab_cart",
      "nodeId": "n_title",
      "offset": { "x": 0, "y": 0 },
      "x": 24,
      "y": 24,
      "status": "open",
      "createdAt": 1767225600000,
      "updatedAt": 1767225600000,
      "messages": [
        { "id": "m_1", "author": { "kind": "user", "name": "Sam" }, "text": "Say how many items.", "createdAt": 1767225600000 }
      ]
    },
    {
      "id": "th_next",
      "pageId": "pg_flow",
      "x": 480,
      "y": 120,
      "status": "open",
      "createdAt": 1767225600000,
      "updatedAt": 1767225600000,
      "messages": [
        { "id": "m_2", "author": { "kind": "agent", "name": "Claude" }, "text": "Payment screen goes here.", "createdAt": 1767225600000 }
      ]
    }
  ]
}`,
};

/**
 * Guides served by get_guide. Written for agents: short, specific, and in
 * the order things go wrong. Each one stands alone.
 */
export const GUIDES = {
  basics: `# Ponzu basics

A .design is a folder. Each artboard is one HTML file in pages/<page>/. Tokens live in tokens.css. Everything you do is saved immediately and shows up live in the person's canvas.

Workflow
1. get_basic_info, then read_notes. When the person says "this", look for the comment they pinned to it.
2. Before building something new, settle a direction: palette, type scale, spacing. Put it in tokens with set_tokens. Write the brief to a note.
3. Build in small pieces. One write_html call per visual group: a header, then a row, then a card. The person watches the canvas as you work.
4. screenshot after every few writes. Read the lint lines. Fix clipped text and overflow before moving on. When you add motion or states, record them (get_guide('motion')). If a screenshot fails, its error says why: a renderer that didn't answer means the Ponzu app is busy or showing a dialog, so ask the person; one that isn't running is restarting, so try again shortly. Keep working in Ponzu rather than rendering the page some other way.
5. The canvas shows which artboards you're changing on its own. To tell the person what you're doing, set_status with a few words. When you take on a new request, pass intent too: what they asked for, in one plain line.
6. When you point the person at your work in chat, give them the Link from get_basic_info, not the folder path: a path opens their editor, the link opens Ponzu. Point at the exact work: add &artboard=<id> to open on one artboard, or &page=<id> to open on a whole page (a flow, a set of options). With both, it opens on the artboard if it's on that page, otherwise on the page.
7. Explain your work on the canvas itself. A small artboard beside the work, named "Note: …" with height fit-content, holds rationale, labels, a flow's arrows or what to compare. Color it with light-dark() tokens so it suits the person's canvas in either theme (Light and dark, below). The canvas is infinite, so annotate generously. Comments are for what needs the person: a question, a decision, something you couldn't do.

Several files open: a call without file goes to the file that holds the ids it passes, else the one you last created, named or edited. Pass file once to switch; list_files marks the current one.

HTML and CSS
- Inline styles only (style="…"). No <style> blocks unless you need @keyframes or :hover; keep those inside the artboard.
- Layout with flexbox and grid, spacing with gap and padding. Artboards are flex columns by default, even when their style sets display: flex. HTML from elsewhere that sets display: flex on the root expects a row, so set flex-direction: row on it or its side-by-side panes stack.
- Use var(--token) for colors, fonts, sizes. Add a token rather than repeating a raw value.
- Any Google Font named in font-family loads automatically, with the weights and italics it has. Name it exactly ("Inter Tight", "Instrument Serif"); lint says when a font didn't load and what shows instead.
- Images: https URLs, data URLs, or files in assets/ referenced as assets/name.png.
- SVG for icons and logos. Transforms work.
- Animation is real: @keyframes, transitions, animation-timeline. Screenshots show the settled page; record shows the motion. get_guide('motion') has the details.
- No scripts and no on* handlers; they're stripped. The result tells you what was removed. The one exception is a scene, a <script type="ponzu/act"> that plays the artboard as a product demo and never runs as code (get_guide('act')).
- Name meaningful layers with data-name="Hero". Names make get_tree readable and survive into implementation.

Light and dark
The person may have their canvas in dark mode; get_basic_info says which. Artboards show in that theme, and screenshots default to it.
- Boards you make to talk to the person follow their canvas. Notes, explainers, diagrams, comparisons, decision docs, plans and cost tables are read, not shipped: give them light-dark() colors so a dark canvas shows them dark and a light one light. A few tokens cover them: paper, raised surface, ink, muted ink, line and an accent, e.g. --note-paper: light-dark(#f6f5f2, #1b1b1a). Do this even in a design whose product screens have one look.
- A product's own screens follow the product. One that has a single look keeps it: plain colors stay as they are in both themes.
- A design with both themes puts every color in a light-dark() token: --color-paper: light-dark(#fafaf9, #121212). Use the tokens for text, surfaces, borders, shadows and dot grids alike. A raw #fff or rgba(0,0,0,.06) beside them stays light when the rest turns dark.
- Content that should look one way in either theme (a mock of a light app, a photo's caption, a code block) sets color-scheme: light or dark on its wrapper. light-dark() inside it then picks that side.
- Lint checks a themed design's colors in both themes, and says which text or surface stops reading in the other one. Screenshot the other theme with colorScheme before you call it done.

Results are lean: ids of what you created, and what was dropped. Use get_tree to see structure, get_node for one node's detail.

A whole artboard's content can go in one write_html call: target the artboard with mode replace-children. Content too big for a call (a long table, a diagram from a script) can go straight into the artboard's file instead, at the path create_artboard returns. Write it whole: to a temp file beside it (name.html.tmp), then rename that over it. Ponzu picks the edit up live. Elements without a data-id get one: ids from get_tree keep pointing at the same element across later edits to the file, and Ponzu writes them in when it needs to. get_guide('format') has the files and their fields.

Don't
- Don't rebuild what exists. duplicate it and edit the copy.
- Don't overwrite an artboard the person liked. Put variations next to it (get_guide('variations')).
- Don't guess sizes from screenshots. get_node has the real values.
- Don't resolve a comment you didn't address. Resolve the ones you did, without a reply unless there's something to say.`,

  layout: LAYOUT_GUIDE,

  typography: TYPOGRAPHY_GUIDE,

  watch: `# Watching the canvas

The person comments in the canvas; you pick each comment up, make the change and resolve it. No chatting required.

When to watch: whenever the person might react to the work on the canvas. That's after you've put up something new for them to review, when you're designing together, or when they ask you to watch their comments. Watch instead of ending your turn. Never end a turn asking them to comment on the canvas, or to tell you once they have: they shouldn't have to come back to chat to hand you work that's already on the canvas. A wait that hears nothing costs next to nothing.

Watching doesn't cut you off from chat. A message the person types reaches you as soon as the current wait returns, within a minute. To tell them something (here's the link, which option you'd pick), write it in chat, then keep watching.

1. listen: wait_for_activity with the cursor from your last call. Start with types comment.created, comment.replied, comment.edited, file.changed. An edit replaces what the comment asks; work from the new text. If the wait says Ponzu restarted or lost track, it lists the open threads waiting on you instead: work through those, then carry on with the cursor it gives. If it says Ponzu stopped and isn't back yet, nothing was checked: wait again with the cursor it gives, as Ponzu is most likely restarting into an update. The wait hears from every file you've worked in this session and names the file for any event outside the one you passed: pass that file when you act on it.
2. triage each comment:
   - change ("make this bigger", "try blue"): do it.
   - question ("why this font?"): reply with an answer, leave it open.
   - decision ("A or B?"): reply with your recommendation, leave it open for them.
   Batch comments that touch the same artboard.
3. say what you're doing: set_status with a few words ("adding the autumn drop") and the artboards you're about to touch. The person sees a yuzu ring round the artboard and rain in its header, and your status when they hover the rain.
4. do + check: edit, screenshot, fix lint. Variations go next to the original, never over it.
5. close: for a change you made, set_comment_status resolved. That hides the pin; the canvas already shows the change, so don't reply. While the person is writing a reply in a thread it can't be resolved: leave it, and their reply comes in on a later wait.
6. Go back to 1 with the new cursor. Waiting again clears your working indicator. Keep watching until the person says stop or you're interrupted.

Reply only when the person needs to read something:
- they asked a question, or asked for your recommendation;
- the comment was ambiguous and you picked one reading (say which, in a sentence);
- you couldn't do it, or did something different from what they asked (say why).
Leave a thread you replied to open: resolved threads leave the canvas, so a reply on one is never seen. The person resolves it once they've read it.
Replies are one or two sentences. A reply that just says "Done" or restates the change is noise.

Keep each wait at the default 60 seconds or less, so a chat message never sits for long. When one arrives, it comes first; go back to watching once it's handled, unless it moved you on to something else.
If you started watching yourself and nothing has come in for half an hour, stop and tell the person in a sentence that you'll pick their comments up when they ask.

file.changed means someone edited the HTML outside Ponzu (an editor, another agent). Re-read before editing that artboard.
Never resolve a question or decision for the person. Never resolve a comment you didn't address.`,

  variations: `# Variations

- duplicate the artboard (names: "Hero / A", "Hero / B"). Copies land to the right of the original.
- Change one idea per variation, and say what it is in the name. Three is usually enough.
- Keep the original untouched so the person can compare.
- Put the rationale on the canvas: a "Note: Hero options" artboard beside the set, one line per variation ("B: tighter type, warmer palette") and what to compare.
- Ask the person to pick in chat, then watch the canvas (get_guide('watch')) for their answer.
- When the person picks one, move the others to the Archive with archive.`,

  implement: `# Implementing a design in code

The .design folder is the spec. Read it directly from disk; don't screenshot and guess.

- tokens.css maps to the codebase's theme (CSS variables, Tailwind @theme, a tokens file). Copy names and values.
- Each artboard's HTML has exact values: sizes, colors, spacing, font settings. data-name tells you what each layer is.
- Translate the structure into the codebase's components; don't paste the HTML. Keep flex/grid decisions.
- Open comment threads may hold requirements ("this should collapse on mobile"). Read comments.json.
- notes/ has the brief and decisions. Read them before you start.
- "Note: …" artboards explain the screens beside them. Read them alongside the screens they sit next to.
- A <script type="ponzu/act"> is a scene: a scripted demo of the screen, not the product's behavior. Read it for intent and build real interactions.
- When something can't be built as drawn, leave a comment on the node explaining what you did instead.`,

  format: `# The .design format

Write the files yourself only to bring in or generate a lot at once: a design ported from another tool, a diagram from a script, dozens of artboards. Ponzu picks them up live. For an artboard you made with create_artboard, write its file once the call returns, at the path it gives. Write each file whole: write a temp file beside it (cart.html.tmp), then rename it over the real one. A file caught half-written shows as it last was until it's finished, and get_basic_info lists it as still being written. Then open the design with get_basic_info (it lists anything Ponzu couldn't use), screenshot each artboard and fix what lint reports. For everything else use the tools: they lint as you go and the person can undo them.

name.design/
  design.json                   name and pages
  tokens.css                    :root { --color-ink: #111; }
  comments.json                 comment threads (optional)
  notes/<name>.md               the brief and decisions
  assets/                       images and fonts, used as assets/logo.png
  pages/<page>/<artboard>.html  one artboard per file

design.json
\`\`\`json
${FORMAT_EXAMPLE["design.json"]}
\`\`\`
- Give every page an id. Without one it gets a new id each time the design loads, and comments on its canvas lose their page.
- A page's folder is its name, lowercase with dashes: "Home screens" lives in pages/home-screens/. Pages sharing a name get -2, -3 in list order. Renaming or reordering pages moves their folders, so take each page's folder from get_basic_info before writing into it. A folder no page names becomes a page of its own.
- icon is optional, on the file and on each page. Name what's inside as specifically as the list allows, and give pages in one file different icons. One of:
${ICON_LIST}

An artboard, pages/flow/cart.html
\`\`\`html
${FORMAT_EXAMPLE["pages/flow/cart.html"]}
\`\`\`
- One <section data-artboard> per file holds the whole artboard.
- Size goes in style, as width and height in px. data-x and data-y only place the artboard on its page. Without a width or height it's 1440×900; height: fit-content grows with the content.
- Give the section a data-id (ab_…) so comments and tools can point at it. Elements inside don't need one: they get stable ids from their position.
- data-name is the name people see, for the artboard and for layers.
- Same HTML and CSS rules as write_html (get_guide('basics')): inline styles, var(--token), no scripts but a scene (get_guide('act')).

comments.json
\`\`\`json
${FORMAT_EXAMPLE["comments.json"]}
\`\`\`
- Every thread needs id, x, y, status ("open" or "resolved"), createdAt, updatedAt and at least one message. Times are milliseconds since 1970.
- On an artboard: artboardId, and nodeId to pin it to a node inside. x and y are measured from the artboard's top-left corner.
- On a node, offset ({ "x", "y" }, optional) is the pin's place in the node, from its top-left corner, so the pin moves with the node. Without it the pin stays at x, y, kept within the node.
- On a page's open canvas: pageId instead. x and y are its place on the page, the same space as data-x and data-y.
- Each message needs id, author ({ "kind": "user" or "agent", "name" }), text and createdAt. Bringing comments over from another tool, keep who wrote them.
- A thread missing any of this isn't shown. get_basic_info says which thread and what it needs; the file keeps it until you fix it.`,

  motion: MOTION_GUIDE,

  product: PRODUCT_GUIDE,

  act: ACT_GUIDE,

  kit: KIT_GUIDE,

  mobile: MOBILE_GUIDE,
} as const;

export type GuideTopic = keyof typeof GUIDES;

/**
 * Short server instructions shown to every MCP client on connect. Some
 * clients list only the first line until the tools load (Codex keeps 250
 * characters of it), so that line says what Ponzu is and when to use it.
 */
export const SERVER_INSTRUCTIONS = `Ponzu is a design canvas you drive with HTML and CSS. Use it when showing beats describing: a screen or flow before you build it, options to pick from, a diagram. The person sees it live and steers with comments.

Once you've put work on the canvas for the person to react to, or you're designing together, watch the canvas instead of ending your turn: wait_for_activity → triage → set_status → edit + screenshot → set_comment_status resolved for what you did (reply only to answer a question, flag an ambiguity or explain what you couldn't do) → wait again. Never end a turn asking the person to comment on the canvas or to tell you when they have; watch for their comments instead. Watching doesn't cut you off from chat: their messages reach you between waits, within a minute, and you can write to them in chat and keep watching. Handle chat first. A wait that hears nothing is cheap. If you started watching yourself, stop after 30 quiet minutes and say so. Read get_guide('watch') before your first wait.

Start every session with get_basic_info, then read_notes, then get_guide('basics') if you haven't read it. When the person says "this", look for the comment they pinned to it.

For a product shot (faux product UI for a launch page: a hero, a feature card, a bento grid, a cursor walking through a flow), read get_guide('product') first.

Build in small pieces, screenshot often, and fix what lint reports. Screenshots show the theme the person's canvas is in; a design with both themes uses light-dark() tokens for every color, and so do the notes, diagrams and docs you make to explain something to the person, so they read on a dark canvas too. record shows animation and hover states frame by frame. Put design decisions in tokens and notes. Variations go next to the original, never over it. The canvas shows which artboards you're changing; set_status tells the person what you're doing, and its intent, set once per request, says what they asked for.

The canvas is yours to annotate: a "Note: …" artboard beside the work carries rationale, labels and what to compare. Comments carry what needs the person: a question, a choice, something you couldn't do.

To send the person to a design in chat, give them the Link from get_basic_info (with &page=<id> for a page, &artboard=<id> for one board), never the folder path: a path opens their editor, the link opens Ponzu.

When Ponzu gets in your way (a confusing tool, an error, something it can't do) or works notably well, tell the Ponzu team with send_feedback, then carry on.`;
