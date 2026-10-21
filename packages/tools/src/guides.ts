/**
 * Guides served by get_guide. Written for agents: short, specific, and in
 * the order things go wrong. Each one stands alone.
 */
export const GUIDES = {
  basics: `# Ponzu basics

A .design is a folder. Each artboard is one HTML file in pages/<page>/. Tokens live in tokens.css. Everything you do is saved immediately and shows up live in the person's canvas.

Workflow
1. get_basic_info, then read_notes. If the person selected something, that's what "this" means.
2. Before building something new, settle a direction: palette, type scale, spacing. Put it in tokens with set_tokens. Write the brief to a note.
3. Build in small pieces. One write_html call per visual group: a header, then a row, then a card. The person watches the canvas as you work.
4. screenshot after every few writes. Read the lint lines. Fix clipped text and overflow before moving on. When you add motion or states, record them (get_guide('motion')). If a screenshot fails, its error says why: a renderer that didn't answer means the Ponzu app is busy or showing a dialog, so ask the person; one that isn't running is restarting, so try again shortly. Keep working in Ponzu rather than rendering the page some other way.
5. When you change existing work, call start_working with the artboard ids first and finish_working at the end.

HTML and CSS
- Inline styles only (style="…"). No <style> blocks unless you need @keyframes or :hover; keep those inside the artboard.
- Layout with flexbox and grid, spacing with gap and padding. Artboards are flex columns by default.
- Use var(--token) for colors, fonts, sizes. Add a token rather than repeating a raw value.
- Any Google Font named in font-family loads automatically, with the weights and italics it has. Name it exactly ("Inter Tight", "Instrument Serif"); lint says when a font didn't load and what shows instead.
- Images: https URLs, data URLs, or files in assets/ referenced as assets/name.png.
- SVG for icons and logos. Transforms work.
- Animation is real: @keyframes, transitions, animation-timeline. Screenshots show the settled page; record shows the motion. get_guide('motion') has the details.
- No scripts and no on* handlers; they're stripped. The result tells you what was removed.
- Name meaningful layers with data-name="Hero". Names make get_tree readable and survive into implementation.

Results are lean: ids of what you created, and what was dropped. Use get_tree to see structure, get_node for one node's detail.

Big generated content (a long table, a diagram from a script) can go straight into the artboard's file, pages/<page>/<artboard>.html, instead of through write_html. Ponzu picks the edit up live. Elements without a data-id get one: ids from get_tree keep pointing at the same element across later edits to the file, and Ponzu writes them in when it needs to.

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
- When lint says the artboard overflows, either make the artboard height fit-content or cut content. Don't shrink type to cram.`,

  typography: `# Typography

- Pick two families at most: one for display, one for text (and a mono if the product is technical). Put them in tokens: --font-display, --font-text.
- A type scale of 5–7 sizes, in tokens. Use px for font-size and line-height, em for letter-spacing.
- Display sizes want tighter tracking (-0.02em to -0.04em) and line-height around 1.0–1.1. Body wants 1.4–1.6.
- Weight does a lot. Headlines rarely need more than 600 on a modern grotesk.
- Set text-wrap: balance on headings and text-wrap: pretty on paragraphs.
- Measure: body text 45–75 characters per line (max-width ~ 34em).`,

  collaborate: `# The collaborate loop

Use this when the person wants you to sit with them while they review: they leave comments in the canvas, you pick them up, make the change, and resolve them. No chatting required.

1. listen: wait_for_activity with the cursor from your last call. Start with types comment.created, comment.replied, comment.edited, file.changed. An edit replaces what the comment asks; work from the new text.
2. triage each comment:
   - change ("make this bigger", "try blue"): do it.
   - question ("why this font?"): reply with an answer, leave it open.
   - decision ("A or B?"): reply with your recommendation, leave it open for them.
   Batch comments that touch the same artboard.
3. claim: start_working on the artboards you're about to touch, with a status of a few words ("adding the autumn drop"). The person sees it in the artboard's header while its outline traces.
4. do + check: edit, screenshot, fix lint. Variations go next to the original, never over it.
5. close: for a change you made, set_comment_status resolved. That hides the pin; the canvas already shows the change, so don't reply. Then finish_working.
6. Go back to 1 with the new cursor. Keep looping until the person says stop or you're interrupted.

Reply only when the person needs to read something:
- they asked a question, or asked for your recommendation;
- the comment was ambiguous and you picked one reading (say which, in a sentence);
- you couldn't do it, or did something different from what they asked (say why).
Leave a thread you replied to open: resolved threads leave the canvas, so a reply on one is never seen. The person resolves it once they've read it.
Replies are one or two sentences. A reply that just says "Done" or restates the change is noise.

file.changed means someone edited the HTML outside Ponzu (an editor, another agent). Re-read before editing that artboard.
Never resolve a question or decision for the person. Never resolve a comment you didn't address.`,

  variations: `# Variations

- duplicate the artboard (names: "Hero / A", "Hero / B"). Copies land to the right of the original.
- Change one idea per variation, and say what it is in the name. Three is usually enough.
- Keep the original untouched so the person can compare.
- Put a one-line note on each with create_comment ("B: tighter type, warmer palette") so the decision has context.
- When the person picks one, move the others to the Archive with archive.`,

  implement: `# Implementing a design in code

The .design folder is the spec. Read it directly from disk; don't screenshot and guess.

- tokens.css maps to the codebase's theme (CSS variables, Tailwind @theme, a tokens file). Copy names and values.
- Each artboard's HTML has exact values: sizes, colors, spacing, font settings. data-name tells you what each layer is.
- Translate the structure into the codebase's components; don't paste the HTML. Keep flex/grid decisions.
- Open comment threads may hold requirements ("this should collapse on mobile"). Read comments.json.
- notes/ has the brief and decisions. Read them before you start.
- When something can't be built as drawn, leave a comment on the node explaining what you did instead.`,

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

/** Short server instructions shown to every MCP client on connect. */
export const SERVER_INSTRUCTIONS = `Ponzu is a design canvas you drive with HTML and CSS. The person sees your work live in their canvas and steers with comments.

Start every session with get_basic_info, then read_notes, then get_guide('basics') if you haven't read it. When the person says "this", call get_selection.

Build in small pieces, screenshot often, and fix what lint reports. record shows animation and hover states frame by frame. Put design decisions in tokens and notes. Variations go next to the original, never over it. Use start_working / finish_working around edits to existing artboards.

To pair on feedback, run the collaborate loop: wait_for_activity → triage → start_working → edit + screenshot → set_comment_status resolved for what you did (reply only to answer a question, flag an ambiguity or explain what you couldn't do) → repeat. get_guide('collaborate') has details.

When Ponzu gets in your way (a confusing tool, an error, something it can't do) or works notably well, tell the Ponzu team with send_feedback, then carry on.`;
