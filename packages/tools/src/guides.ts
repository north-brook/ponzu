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
5. The canvas shows which artboards you're changing on its own. To tell the person what you're doing, set_status with a few words.
6. When you point the person at your work in chat, give them the Link from get_basic_info, not the folder path: a path opens their editor, the link opens Ponzu. Add &artboard=<id> to open on one artboard.
7. Explain your work on the canvas itself. A small artboard beside the work, named "Note: …" with height fit-content, holds rationale, labels, a flow's arrows or what to compare. The canvas is infinite, so annotate generously. Comments are for what needs the person: a question, a decision, something you couldn't do.

Several files open: a call without file goes to the file that holds the ids it passes, else the one you last created, named or edited. Pass file once to switch; list_files marks the current one.

HTML and CSS
- Inline styles only (style="…"). No <style> blocks unless you need @keyframes or :hover; keep those inside the artboard.
- Layout with flexbox and grid, spacing with gap and padding. Artboards are flex columns by default, even when their style sets display: flex. HTML from elsewhere that sets display: flex on the root expects a row, so set flex-direction: row on it or its side-by-side panes stack.
- Use var(--token) for colors, fonts, sizes. Add a token rather than repeating a raw value.
- Any Google Font named in font-family loads automatically, with the weights and italics it has. Name it exactly ("Inter Tight", "Instrument Serif"); lint says when a font didn't load and what shows instead.
- Images: https URLs, data URLs, or files in assets/ referenced as assets/name.png.
- SVG for icons and logos. Transforms work.
- Animation is real: @keyframes, transitions, animation-timeline. Screenshots show the settled page; record shows the motion. get_guide('motion') has the details.
- No scripts and no on* handlers; they're stripped. The result tells you what was removed.
- Name meaningful layers with data-name="Hero". Names make get_tree readable and survive into implementation.

Light and dark
The person may have their canvas in dark mode; get_basic_info says which. Artboards show in that theme, and screenshots default to it.
- A design with one look doesn't need to change: plain colors stay as they are in both themes.
- A design with both themes puts every color in a light-dark() token: --color-paper: light-dark(#fafaf9, #121212). Use the tokens for text, surfaces, borders, shadows and dot grids alike. A raw #fff or rgba(0,0,0,.06) beside them stays light when the rest turns dark.
- Content that should look one way in either theme (a mock of a light app, a photo's caption, a code block) sets color-scheme: light or dark on its wrapper. light-dark() inside it then picks that side.
- Lint checks a themed design's colors in both themes, and says which text or surface stops reading in the other one. Screenshot the other theme with colorScheme before you call it done.

Results are lean: ids of what you created, and what was dropped. Use get_tree to see structure, get_node for one node's detail.

Big generated content (a long table, a diagram from a script) can go straight into the artboard's file, pages/<page>/<artboard>.html, instead of through write_html. Ponzu picks the edit up live. Elements without a data-id get one: ids from get_tree keep pointing at the same element across later edits to the file, and Ponzu writes them in when it needs to. get_guide('format') has the files and their fields.

Don't
- Don't rebuild what exists. duplicate it and edit the copy.
- Don't overwrite an artboard the person liked. Put variations next to it (get_guide('variations')).
- Don't guess sizes from screenshots. get_node has the real values.
- Don't resolve a comment you didn't address. Resolve the ones you did, without a reply unless there's something to say.`,

  layout: `# Layout

- Artboard sizes: desktop 1440×900, laptop 1280×800, tablet 768×1024, phone 390×844. Long pages: height fit-content.
- Build sections as full-width flex children of the artboard. Constrain content with max-width + margin-inline: auto, or padding-inline.
- Rows of things that must align (lists, tables, nav): give icon and trailing slots a fixed width and flex-shrink: 0. gap alone doesn't align columns across rows.
- Text in a flex row: add min-width: 0 to the text's container, or long words push siblings out.
- Tags and pills inside a flex row stretch to the row's height. Use align-items: flex-start or center on the row.
- Prefer gap over margins. Prefer padding on containers over spacer divs.
- absolute positioning is fine for decoration (badges, glows, overlaps). Don't cover the whole artboard with one absolute element.
- Grid: grid-template-columns: repeat(12, 1fr) for page layouts; repeat(auto-fill, minmax(240px, 1fr)) for card grids.
- When lint says the artboard overflows, either make the artboard height fit-content or cut content. Don't shrink type to cram.
- A fit-content artboard grows down the canvas as you add to it, over anything placed below it. When lint says two artboards overlap, move the lower one to the y it gives.`,

  typography: `# Typography

- Pick two families at most: one for display, one for text (and a mono if the product is technical). Put them in tokens: --font-display, --font-text.
- A type scale of 5–7 sizes, in tokens. Use px for font-size and line-height, em for letter-spacing.
- Display sizes want tighter tracking (-0.02em to -0.04em) and line-height around 1.0–1.1. Body wants 1.4–1.6.
- Weight does a lot. Headlines rarely need more than 600 on a modern grotesk.
- Set text-wrap: balance on headings and text-wrap: pretty on paragraphs.
- Measure: body text 45–75 characters per line (max-width ~ 34em).`,

  iterate: `# The iterate loop

The person comments in the canvas; you pick each comment up, make the change and resolve it. No chatting required.

When to run it: whenever you expect the person to react to the work on the canvas. That's after you've put up something new for them to review, when you're designing together, or when they ask you to watch their comments. Don't end your turn to wait for feedback; start the loop instead. A wait that hears nothing costs next to nothing.

1. listen: wait_for_activity with the cursor from your last call. Start with types comment.created, comment.replied, comment.edited, file.changed. An edit replaces what the comment asks; work from the new text.
2. triage each comment:
   - change ("make this bigger", "try blue"): do it.
   - question ("why this font?"): reply with an answer, leave it open.
   - decision ("A or B?"): reply with your recommendation, leave it open for them.
   Batch comments that touch the same artboard.
3. say what you're doing: set_status with a few words ("adding the autumn drop") and the artboards you're about to touch. The person sees your mark in the artboard's header while its outline traces, and your status when they hover it.
4. do + check: edit, screenshot, fix lint. Variations go next to the original, never over it.
5. close: for a change you made, set_comment_status resolved. That hides the pin; the canvas already shows the change, so don't reply.
6. Go back to 1 with the new cursor. Waiting again clears your working indicator. Keep looping until the person says stop or you're interrupted.

Reply only when the person needs to read something:
- they asked a question, or asked for your recommendation;
- the comment was ambiguous and you picked one reading (say which, in a sentence);
- you couldn't do it, or did something different from what they asked (say why).
Leave a thread you replied to open: resolved threads leave the canvas, so a reply on one is never seen. The person resolves it once they've read it.
Replies are one or two sentences. A reply that just says "Done" or restates the change is noise.

Keep each wait at the default 60 seconds or less: a message the person types in chat reaches you only once the wait returns. When one arrives, it comes first; go back to the loop once it's handled, unless it moved you on to something else.
If you started the loop yourself and nothing has come in for half an hour, stop and tell the person in a sentence that you'll pick their comments up when they ask.

file.changed means someone edited the HTML outside Ponzu (an editor, another agent). Re-read before editing that artboard.
Never resolve a question or decision for the person. Never resolve a comment you didn't address.`,

  variations: `# Variations

- duplicate the artboard (names: "Hero / A", "Hero / B"). Copies land to the right of the original.
- Change one idea per variation, and say what it is in the name. Three is usually enough.
- Keep the original untouched so the person can compare.
- Put the rationale on the canvas: a "Note: Hero options" artboard beside the set, one line per variation ("B: tighter type, warmer palette") and what to compare.
- Ask the person to pick in your reply to them.
- When the person picks one, move the others to the Archive with archive.`,

  implement: `# Implementing a design in code

The .design folder is the spec. Read it directly from disk; don't screenshot and guess.

- tokens.css maps to the codebase's theme (CSS variables, Tailwind @theme, a tokens file). Copy names and values.
- Each artboard's HTML has exact values: sizes, colors, spacing, font settings. data-name tells you what each layer is.
- Translate the structure into the codebase's components; don't paste the HTML. Keep flex/grid decisions.
- Open comment threads may hold requirements ("this should collapse on mobile"). Read comments.json.
- notes/ has the brief and decisions. Read them before you start.
- "Note: …" artboards explain the screens beside them. Read them alongside the screens they sit next to.
- When something can't be built as drawn, leave a comment on the node explaining what you did instead.`,

  format: `# The .design format

Write the files yourself only to bring in or generate a lot at once: a design ported from another tool, a diagram from a script, dozens of artboards. Ponzu picks them up live. Then open the design with get_basic_info (it lists anything Ponzu couldn't use), screenshot each artboard and fix what lint reports. For everything else use the tools: they lint as you go, the person can undo them, and the canvas shows who's working.

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
- icon is optional, on the file and on each page: page, home, phone, desktop, flow, palette and the rest of create_file's list.

An artboard, pages/flow/cart.html
\`\`\`html
${FORMAT_EXAMPLE["pages/flow/cart.html"]}
\`\`\`
- One <section data-artboard> per file holds the whole artboard.
- Size goes in style, as width and height in px. data-x and data-y only place the artboard on its page. Without a width or height it's 1440×900; height: fit-content grows with the content.
- Give the section a data-id (ab_…) so comments and tools can point at it. Elements inside don't need one: they get stable ids from their position.
- data-name is the name people see, for the artboard and for layers.
- Same HTML and CSS rules as write_html (get_guide('basics')): inline styles, var(--token), no scripts.

comments.json
\`\`\`json
${FORMAT_EXAMPLE["comments.json"]}
\`\`\`
- Every thread needs id, x, y, status ("open" or "resolved"), createdAt, updatedAt and at least one message. Times are milliseconds since 1970.
- On an artboard: artboardId, and nodeId to pin it to a node inside. x and y are measured from the artboard's top-left corner.
- On a page's open canvas: pageId instead. x and y are its place on the page, the same space as data-x and data-y.
- Each message needs id, author ({ "kind": "user" or "agent", "name" }), text and createdAt. Bringing comments over from another tool, keep who wrote them.
- A thread missing any of this isn't shown. get_basic_info says which thread and what it needs; the file keeps it until you fix it.`,

  motion: `# Motion and states

Designs have no scripts, so motion is CSS (@keyframes, transitions, animation-timeline) and SVG <animate>. Ponzu pauses it and seeks to exact times, so frames are the same every time and cost no real waiting.

See it
- screenshot shows the settled page: every finite animation has finished. at: 0 shows the first frame; any other at shows that moment.
- record returns one contact sheet of frames labeled by time, plus a list of what animates (node, keyframes, duration, delay, easing, iterations). Default: the whole load, or one cycle of a loop. Raise frames (12–16) for fast or detailed motion; use from/to to zoom into a stretch.
- hover, focus or press (a node id) on either tool puts that node in the state first. record then shows the transition into it, starting from the settled page.
- scroll (a scroll container's id) on record steps through its scroll range, for animation-timeline: scroll() and view(). The container needs a fixed height and overflow: auto.

Write it
- Put @keyframes and state rules in a <style> inside the artboard. Name a class on the element (class="cta") and target it: .cta:hover { … }.
- Inline styles beat <style> rules. A state rule that changes a property the element also sets inline needs !important. Lint tells you when a state changes nothing.
- Entrance animations that start hidden (opacity: 0) need animation-fill-mode: forwards (or both), or the element snaps back to hidden when they end. Lint catches this.
- Put the transition on the base rule, not the :hover rule, so it eases both ways.
- Keep entrances short: 200–600ms, staggered 50–100ms. Use ease-out for things arriving and ease-in for things leaving. Loops should be slow and subtle.
- Animate transform and opacity. Animating width, height, top or margin moves the layout around it.
- Keep fewer than 100 elements animating at once, counting loops and entrances that hold their end with forwards. Each is its own layer, and past that the whole canvas drops frames. For a field of dots, animate one HTML wrapper per row, or one around the lot, not every dot; an SVG <g> repaints everything in it each frame. Lint counts them.

Check
1. screenshot: the settled page is what people see most. Lint it like any other.
2. record the load: does each thing arrive in order, and nothing jump or overlap?
3. record hover/focus/press on every interactive element you styled. A state without a transition snaps; that's fine for focus rings, rarely for hover.
4. Read the motion list: delays and durations should add up to the rhythm you meant.`,

  mobile: `# Mobile

- 390×844 artboards. Include a status bar (time, signal, battery) as a 54px row at the top; make it a duplicated component across screens.
- Respect safe areas: 54px top, 34px bottom home indicator.
- Touch targets at least 44×44.
- Body text 16–17px. Don't go below 13px for anything readable.
- Bottom tab bars: 5 items max, icons with short labels.
- Show flows as a row of screens left to right, in order, named "1 Welcome", "2 Sign in"…`,
} as const;

export type GuideTopic = keyof typeof GUIDES;

/**
 * Short server instructions shown to every MCP client on connect. Some
 * clients list only the first line until the tools load (Codex keeps 250
 * characters of it), so that line says what Ponzu is and when to use it.
 */
export const SERVER_INSTRUCTIONS = `Ponzu is a design canvas you drive with HTML and CSS. Use it when showing beats describing: a screen or flow before you build it, options to pick from, a diagram. The person sees it live and steers with comments.

Start every session with get_basic_info, then read_notes, then get_guide('basics') if you haven't read it. When the person says "this", look for the comment they pinned to it.

Build in small pieces, screenshot often, and fix what lint reports. Screenshots show the theme the person's canvas is in; a design with both themes uses light-dark() tokens for every color. record shows animation and hover states frame by frame. Put design decisions in tokens and notes. Variations go next to the original, never over it. The canvas shows which artboards you're changing; set_status tells the person what you're doing.

The canvas is yours to annotate: a "Note: …" artboard beside the work carries rationale, labels and what to compare. Comments carry what needs the person: a question, a choice, something you couldn't do.

To send the person to a design in chat, give them the Link from get_basic_info (with &artboard=<id> for one board), never the folder path: a path opens their editor, the link opens Ponzu.

When you've put work on the canvas for the person to react to, or you're designing together, run the iterate loop rather than ending your turn: wait_for_activity → triage → set_status → edit + screenshot → set_comment_status resolved for what you did (reply only to answer a question, flag an ambiguity or explain what you couldn't do) → repeat. A wait that hears nothing is cheap. Keep each wait at 60 seconds or less, since a chat message reaches you only when a wait returns, and handle chat first. If you started the loop yourself, stop after 30 quiet minutes and say so. Read get_guide('iterate') before your first wait.

When Ponzu gets in your way (a confusing tool, an error, something it can't do) or works notably well, tell the Ponzu team with send_feedback, then carry on.`;
