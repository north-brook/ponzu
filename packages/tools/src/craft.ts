/**
 * The guides that are about the work and not about where a canvas lives: every host serves
 * them as they are. Product shots, scenes and the kit are in product.ts.
 */

export const LAYOUT_GUIDE = `# Layout

- Artboard sizes: desktop 1440×900, laptop 1280×800, tablet 768×1024, phone 390×844. Long pages: height fit-content.
- Build sections as full-width flex children of the artboard. Constrain content with max-width + margin-inline: auto, or padding-inline.
- Rows of things that must align (lists, tables, nav): give icon and trailing slots a fixed width and flex-shrink: 0. gap alone doesn't align columns across rows.
- Text in a flex row: add min-width: 0 to the text's container, or long words push siblings out.
- Tags and pills inside a flex row stretch to the row's height. Use align-items: flex-start or center on the row.
- Prefer gap over margins. Prefer padding on containers over spacer divs.
- absolute positioning is fine for decoration (badges, glows, overlaps). Don't cover the whole artboard with one absolute element.
- Grid: grid-template-columns: repeat(12, 1fr) for page layouts; repeat(auto-fill, minmax(240px, 1fr)) for card grids.
- When lint says the artboard overflows, either make the artboard height fit-content or cut content. Don't shrink type to cram.
- A fit-content artboard grows down the canvas as you add to it, over anything placed below it. When lint says two artboards overlap, move the lower one to the y it gives.`;

export const TYPOGRAPHY_GUIDE = `# Typography

- Pick two families at most: one for display, one for text (and a mono if the product is technical). Put them in tokens: --font-display, --font-text.
- A type scale of 5–7 sizes, in tokens. Use px for font-size and line-height, em for letter-spacing.
- Display sizes want tighter tracking (-0.02em to -0.04em) and line-height around 1.0–1.1. Body wants 1.4–1.6.
- Weight does a lot. Headlines rarely need more than 600 on a modern grotesk.
- Set text-wrap: balance on headings and text-wrap: pretty on paragraphs.
- Measure: body text 45–75 characters per line (max-width ~ 34em).`;

export const MOTION_GUIDE = `# Motion and states

Canvases run no scripts, so motion is CSS (@keyframes, transitions, animation-timeline), SVG <animate>, and scenes: a product demo written as beats (click, type, show, count) that Ponzu turns into animations (get_guide('act')). Ponzu pauses all of it and seeks to exact times, so frames are the same every time and cost no real waiting.

See it
- screenshot shows the settled page: every finite animation has finished. at: 0 shows the first frame; any other at shows that moment.
- record returns one contact sheet of frames labeled by time, plus a list of what animates (node, keyframes, duration, delay, easing, iterations). Default: the whole load, or one cycle of a loop. Raise frames (12–16) for fast or detailed motion; use from/to to zoom into a stretch.
- hover, focus or press (a node id) on either tool puts that node in the state first. record then shows the transition into it, starting from the settled page.
- scroll (a scroll container's id) on record steps through its scroll range, for animation-timeline: scroll() and view(). The container needs a fixed height and overflow: auto.

What the person sees
- On their canvas, the load plays once when the artboard appears: when they open its page, and each time you edit it. Then a finite animation holds its end. Hovering or clicking the artboard doesn't replay it, so never tell them it will.
- Their canvas plays what record shows. It holds motion still on purpose: while its window is in the background on battery, while they pan across a crowded page, for parts too small to see at their zoom, and for loops longer than 20 s on an artboard zoomed far out. If record shows the motion working and they say it doesn't play, tell the Ponzu team with send_feedback instead of reworking the board.
- A hint that fades out ends hidden, so the canvas shows nothing once it has played.
- When they need to watch the motion (an entrance to review, a hint that leaves), put a looping copy on an artboard beside the real one: animation-iteration-count: infinite, with a beat of about a second held at the end of the keyframes so each cycle reads as one play. Keep the real one finite, and say which is which in a note.
- If the motion answers something the person does, put it on :hover or :focus, so they can set it off themselves.

Write it
- Put @keyframes and state rules in a <style> inside the artboard. Name a class on the element (class="cta") and target it: .cta:hover { … }.
- Inline styles beat <style> rules. A state rule that changes a property the element also sets inline needs !important. Lint tells you when a state changes nothing.
- Entrance animations that start hidden (opacity: 0) need animation-fill-mode: forwards (or both), or the element snaps back to hidden when they end. Lint catches this.
- Put the transition on the base rule, not the :hover rule, so it eases both ways.
- Keep entrances short: 200–600ms, staggered 50–100ms. Use ease-out for things arriving and ease-in for things leaving. Loops should be slow and subtle.
- A <video> from assets/ (muted, loop to repeat) is paused and seeked like any animation, so record and at show its real frames.
- Animate transform and opacity. Animating width, height, top or margin moves the layout around it.
- Keep fewer than 100 elements animating at once, counting loops and entrances that hold their end with forwards. Each is its own layer, and past that the whole canvas drops frames. For a field of dots, animate one HTML wrapper per row, or one around the lot, not every dot; an SVG <g> repaints everything in it each frame. Lint counts them.

Check
1. screenshot: the settled page is what people see most. Lint it like any other.
2. record the load: does each thing arrive in order, and nothing jump or overlap?
3. record hover/focus/press on every interactive element you styled. A state without a transition snaps; that's fine for focus rings, rarely for hover.
4. Read the motion list: delays and durations should add up to the rhythm you meant.
5. A finite load the person should judge needs a looping copy beside it; they can't replay the original.`;

export const MOBILE_GUIDE = `# Mobile

- 390×844 artboards. Include a status bar (time, signal, battery) as a 54px row at the top; make it a duplicated component across screens.
- Respect safe areas: 54px top, 34px bottom home indicator.
- Touch targets at least 44×44.
- Body text 16–17px. Don't go below 13px for anything readable.
- Bottom tab bars: 5 items max, icons with short labels.
- Show flows as a row of screens left to right, in order, named "1 Welcome", "2 Sign in"…`;
