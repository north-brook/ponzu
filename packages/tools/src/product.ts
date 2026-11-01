/**
 * Guides for product shots: faux product UI as stills and scenes. The
 * judgment (framing, restraint, story, bento, review) is adapted from
 * Stageshow by Benji Taylor (MIT, github.com/benjitaylor/skills), rewritten
 * for HTML on Ponzu's canvas; the scene language is Ponzu's own
 * (render/src/act.ts).
 */

export const PRODUCT_GUIDE = `# Product shots

Faux product UI: a believable interface, framed the way a launch page frames it, as a still or a short scene in which one thing happens. Heroes beside copy, feature cards, bento grids, cursor walkthroughs. The viewer recognizes the screen and sees the thing happen. (Adapted from Stageshow by Benji Taylor.)

The one idea: it reads as a real product, simplified to what the viewer needs, framed with intent, and every motion has a cause. It fails five ways:
- Too much: real text in every row, numbers everywhere. The more detail, the more it looks generated.
- Wireframe: two gray blobs and a button. Built too small, or stripped of what made it recognizable.
- Boxed: a whole window shrunk into a card with even margins. A screenshot pasted in, not a product shot.
- Flat: every object the same weight in the same bordered card. The eye has nowhere to land.
- Bland: a gray window with a cursor, whatever the brief said. The brief's look and energy (glass over color, a blueprint, a mascot) are the point: build them in full, to these rules.
The fix: a full, structured screen in quiet grays, real words only on what the story is about, placeholder bars for the rest, room to breathe, and a crop that puts the eye where the story is. Simplify the words, not the context.

Press hard. Build it the way a product designer builds a launch page they'll be judged on, then look at it as the most exacting designer you know would: the one who screenshots the single wrong thing (a dot off its avatar, a unit on its own line, copy touching a card) and sends it back with "what is this?". If you can picture that screenshot, it's the next fix.

## Workflow
1. Plan before any HTML, in a note beside the work: where it sits on the page, the focal object, the action, the payoff, what to leave out.
2. Make the artboard the size it's shown, 1:1: about 720×340 for a hero beside copy, 960–1100 wide for a full-width hero, 400×300 for a card or tile, 358 wide for a phone column (a redesign for that width, not a squeeze). Never under about 320 wide for a demo.
3. The look. With the product's code or site to hand, take its tokens, icons, chrome and words. Otherwise light, one accent, a style if the brief names one. Put it in tokens.
4. Pick a layout (below) and build the screen from get_guide('kit'): its stage, window, phone, rows and bars are at real geometry. Count the real strings first.
5. Frame it. screenshot at scale 1 and hold it to the framing rules. If it's emptier, flatter or more boxed than it should be, fix the frame before any motion.
6. Tell the story with a scene (get_guide('act')): three to five beats and a payoff.
7. Rehearse: screenshot (the poster, the frame most people see), record (the storyboard), then review it as a stranger would (Review, below). Fix the largest fault first and film again.

## Framing
1. One hero object, and at most one or two satellites (a receipt, a phone, a detail card) that carry the point.
2. Keep what identifies the product: a title, its real chrome, the rows that give the action a reason. Logo and nav aren't required; crop around the story.
3. Crop only filler. The payoff, the action, what the cursor touches and every real word stay whole. A button, chip or shadow sliced by the edge is the usual fault. If the story doesn't fit, change the size or the layout.
4. Crop 10 to 40% of the hero off the stage. The window or phone fills at least two thirds of the width and runs off an edge. Shapes that read when cut (a card, a list, a row of avatars) run off by a third or more.
5. The stage masks everything: the picture goes in a stage that clips (kit). One gutter: the hero's inset from the edge, and every other edge distance in the frame matches it. A full gutter or well past: never a few pixels short of an edge, never crossing it by under 24px.
6. Satellites straddle the hero's edge, about half outside, over its chrome, sidebar or margin, never its content. Two satellites are two kinds and sizes (a card and a notification), never a stack of two cards.
7. Anchored UI (a menu, a popover, a toast) isn't a satellite: it sits where the product puts it.
8. Depth from distinct shadows: the hero's, a satellite's, a lone surface's (kit). Start flat and frontal; a tilt earns its place against the straight version.
9. A window keeps its shape: whole, 1.25:1 or wider; cropped, what shows is at least square.
10. What the story opens stays in frame, a gutter from every edge, on every frame: place the trigger so the menu has room.
11. On a white or dark page, the page is the ground: no tinted plate behind the window, and no whole window floating with air on four sides. On a colored ground the hero is inset 8–20% from the sides and runs off the bottom.
12. No dead corners, at rest or anywhere in the loop.

## Layouts
| Layout | Hero | Satellite | For |
|---|---|---|---|
| Corner bleed | inset 10% top and left (one gutter), 15–35% past right and bottom | straddling the left or bottom edge | a hero beside copy |
| Pinned, bottom bleed | inset 8–12% left, right and top; 15–35% past the bottom; centered | optional, straddling a side | feature cards, bento tiles |
| Stage with gutters | inset 8–20% each side on a colored ground, off the bottom | straddling one side | brand moments |
| Satellite focus | cropped hard, mostly context | large, 30–40% of the hero's width, carrying the story | one small thing: a notification, a receipt, a diff |
| Wide hero | a 900–1100px window at 1:1, inset top, off the bottom; realistic content | a card on its lower edge | full-width homepage heroes |
| Device pair | desktop inset top-left, 75–80% wide, off the bottom | a phone straddling the right edge, a third outside | one event across devices |
| Many of one | a grid of one thing off every edge; one in focus by depth, the only one with words | none | templates, deploys, sessions |
| Close-up | the window scaled 1.3–1.6×, chrome and all, off the bottom; the subject row whole | none | a card about one control |
| Panel over product | product inset top-left, off the bottom | a settings panel over its margin, one leader to what it changed | a setting and its effect |
| Stacked cards | two components at one width, 12px apart, the lower one off the bottom | none | a setting over what it drives |
| Opposite corners | copy bottom-left at the tile's inset; the product hung off the top-right corner | none | bento tiles with a line of copy |
| Tilted stack | three same-size cards at -6°, 4°, -2°, offset 12–20px; the straightest on top, the only one with words | none | paper: receipts, tickets |

## The screen
- Count the real strings: the title, the thing acted on, what's typed, the result. Usually 3 to 7; the rest are placeholder bars. It's a budget for words, not elements: a calendar still needs a populated week, a search a collection.
- Words where the eye lands, bars at the edges. Bar widths vary row to row (60, 45, 70, 52%). Label and value match: both words or both bars.
- In a small surface (a popover, a card, a tile) a row is one line: avatar, name, value.
- One number gets to be big. Say each thing once: one clear signal for the feature, not in the header, the satellite and every row.
- Keep the domain's signature content: album art, thumbnails, avatars. Named avatars take their own muted color; gray discs are filler.
- Real sizes: 11–15px UI text, line height at least 1.3, one family (the product's or the system's), sentence case, hierarchy from spacing and one weight step. A faux app's title is a div, never an h1: the demo lives in someone's page outline.
- Spacing: words keep 12px from any window, card or row edge; rows pad 12px (8 dense); a button keeps 8px from what's above it; text never touches a neighbor. No near-tangents: edges 1–3px apart read as accidents, so line them up or part them by 8px or more. A title sits closer to its subtitle (4–6px) than to the next record.
- A centered amount centers its digits: the currency sign hangs off the left, outside the centering.
- Icons come from a set chosen on purpose (the product's own; else Phosphor, Tabler, Radix, Heroicons, Material Symbols; Lucide deliberately), one size and weight per scene, filled at 14px and under, one opaque color. Never drawn by hand. Emoji are content, never icons.
- AI features get no sparkle, wand or star, and no purple as the AI color. Show what the AI does.
- No invented logo: a letter in a colored square isn't a mark. Use the real one, or a plain text wordmark. Other companies' marks come from their own assets, in their proportions.
- Color: one neutral family, five inks and one accent; status colors mean status. A filled button under the pointer steps its own color, never a gray swap. The hero isn't outlined to point at it. Nothing translucent overlaps. On dark themes depth comes from lighter surfaces, not shadow.
- Platform chrome is never drawn from memory: windows and phones from the kit, at their real geometry. Nothing sits under the island; a phone is lit from its first frame.

## The story
- Pick its shape from what the product is valued for. How it feels to use: one gesture, the result under the hand. A flow: a few screens told as one object, the payoff last. What the system does: the consequence lands somewhere else, usually with no cursor at all (no stand-in focus ring walking between controls either).
- Open on a finished screen that works as a still: real content on screen before the first beat.
- Three to five beats building to a payoff; a hero loop runs 10–16s. No cursor move you can't explain; between beats it rests on empty surface near its next move. Between a richer story and a calmer frame, choose the frame.
- The payoff is visible at the shown size, arrives full, and holds about 2s. Nothing sits still longer than 3s.
- UI feedback is as quick as the real product's; only storytelling slows down. Related changes overlap, 40–80ms apart in reading order; the result still follows its cause.
- Every change moves: numbers roll, text types or streams, a new row opens its height and carries the rows below. Nothing pops in or snaps out. Solid things (windows, phones, cards) arrive by moving, opaque; they don't fade through.
- The poster tells the story on its own: after the action, with the result still on screen, never mid-change. Cover the motion and ask what happened; if the poster can't answer, choose another beat.
- Loops: a reset removes what the scene added as one thing, with a cause where one exists (a close, an undo, a clear). Data never rewinds in view. A navigation never plays backwards. Within a second of the reset, the next action has begun.

## Bento grids
A grid is one picture made of tiles, not five demos side by side. Plan the tile list in a note first: span, kind, the one thing, the words.
1. About a third to a half of the tiles show UI. The rest are other kinds: a stat (one real number at 48–72px, a short lead, a one-line label, never "10x" filler), a statement in large type, an object, a diagram, a collection of marks bleeding off, a real photo (never a scene drawn in CSS to stand in for one).
2. One hero tile, bigger (two columns or two rows), with the richest picture. Window chrome appears at most once in a grid, on the hero.
3. A UI tile shows one component at real size or larger, cropped by the tile, not a shrunken window.
4. Neighbors contrast, across and down: a picture beside a number, dense beside calm. Two window crops never sit side by side.
5. Copy is short and outside the picture: one to four words or one sentence, at page size (17–24px). A bold lead with a gray continuation reads well.
6. Tiles share radius, gap, padding and where the copy sits; the variety is inside them. Say each thing once across the set.
7. Motion has one place to lead: one tile tells a short story, or each does one small thing once, staggered 80–120ms in reading order.

## Review
Before handing it over, look at the poster and the storyboard as a stranger would, and answer from the frames, not the code:
- Does this composition answer this product, or could it be any product in its category?
- What does the eye land on first, and is it the result? Is one object clearly leading?
- Anything floating with even margins on four sides? A plate behind a window on a white page? A dead corner? A void under a list?
- Gray bars where the eye lands? Busy rows? Uneven insets? Words touching an edge?
- Anything cut by the edge that isn't filler? Anything the story opens outside the frame?
- The cursor covering the words it clicks? Content that swaps instead of moving? A reset with no cause?
Fix the largest fault first: framing, then hierarchy and density, then motion, then polish. Put a "Note: …" beside the work naming the layout and what you'd check next.`;

export const ACT_GUIDE = `# Scene scripts

A scene plays an artboard as a product demo: the cursor moves, clicks and types, things appear, a total rolls. Write it as one <script type="ponzu/act"> inside the artboard, a beat per line. It never runs as code: Ponzu measures the board and turns the beats into animations, so screenshot shows the scene's poster, record films it beat by beat, and the person's canvas plays it on a loop.

The HTML is the cast. Build the whole screen first, every piece in place and in its finished look: the email already in its field, the toast where it lands, the new total. The scene says when each piece appears and how it gets there. Without the scene, the artboard is the finished picture.

\`\`\`html
<script type="ponzu/act">
wait 700
click @Field
type @Email placeholder=@Placeholder
click @Invite
show @"New member" grow
& show @Toast rise
count @Seats from 4
poster
wait 2000
hide @Toast
reset
</script>
\`\`\`

## Targets
- @Name is the element with that data-name; quote names with spaces: @"New member". Any CSS selector works too: .row, [data-name="Plan"] .price.
- The cursor aims at the first match. show, hide, set, unset and count take every match.
- x,y in artboard px, or 80%,60%, is a point with nothing in particular under it.

## Timing
- Beats run one after another. & at the start of a line starts it with the beat before it, and the next beat waits for both. After a click, tap or drag, & starts at the press, not when the cursor sets off: \`click @Send\` then \`& show @Sent\` shows it as the button goes down.
- On any beat: delay=200 starts it later, dur=600 changes how long it takes, ease= takes a curve (house, settle, enter, trip, camera, out, in, inout) or any CSS easing.
- wait 800 holds. A hold is a beat too: give the payoff about 2s.
- A scene loops. End it with reset: everything it changed eases back over 700ms (reset 400 for another length), and what's hidden by then snaps back unseen. Write \`once\` on its own line to play it once and hold the end.
- poster marks the frame that tells the story: screenshot shows it, the canvas's picture of the board shows it, and reduced motion holds it. Put it after the result lands, never mid-change. Without one: where reset begins, or the end.

## The cursor
- move @X travels in a hand's shallow arc, quicker over short hops. The first pointer beat brings the cursor in from the nearest edge; enter @X does that again later.
- click @X moves there, then presses: the cursor dips and the element takes its :active styles. click alone presses where it is. double, right. tap is the same.
- While over something, its :hover rules apply, as if a real pointer were there; they change as the path crosses edges.
- It aims inside the target and off its words: just past the end of a label, toward the right of a wide field. at=0.5,0.5 aims at the center, at=0.9,0.5 near the right edge.
- Its shape comes from what it's over: cursor: pointer shows the hand, text the I-beam, grab the open hand, grabbing the closed one, crosshair, ns-resize and the rest. data-cursor="hand" on an element overrides. A native app's buttons keep the arrow: don't give them cursor: pointer.
- drag @Card to @Done carry presses, closes the hand, travels and lets go; carry moves @Card with it from where it was grabbed (carry=@Other carries something else). While carried it has data-act-dragging: give it a lift with [data-act-dragging] { box-shadow: … }.
- cursor mac (macOS cursors, the default), cursor arrow (a solid illustrated arrowhead, an I-beam over text), cursor touch (a finger on a phone: a soft dot only while it touches). cursor at @X puts it there before the first move. cursor hide, cursor show. cursor ripple rings each click. cursor size=1.5 for a small artboard shown large.
- A cursor that rests 4s steps out of the shot and comes back when it moves.

## Text and numbers
- type @Email reveals the element's own text a character at a time with a caret, and focuses it: :focus and :focus-within rules apply. placeholder=@Hint hides a placeholder on the first character. speed=50 is ms per character; nocaret drops the caret. The caret blinks until focus moves on.
- stream @Answer reveals words in place, across lines, the way a model answers. Nothing reflows, so the space is its final height from the start. A card's own background and border stay; only its words are uncovered.
- count @Total from $1,180 rolls the digits that changed, from the old value to the one in the HTML, last digit first. The element holds just the number: put a unit in its own span.
- key cmd+k shows keycaps (at=top for the top) for a keyboard story. Names: cmd, shift, opt, ctrl, enter, tab, esc, space, backspace, up, down, left, right, and single keys.

## Things appearing, moving and changing
- show @Toast rise: hidden until this beat, then in. fade (the default), rise, drop, pop, blur, from-left, from-right keep the element's space; grow opens its height from nothing so what follows moves down with it, for a row joining a list or a message joining a thread. hide reverses any of them.
- Several matches stagger 60ms in document order; stagger=100 changes it.
- set @Row data-done turns on a state: a class (.done), a data-* or aria-* attribute (data-open, aria-selected=true), or open, hidden, disabled, checked, selected, inert. unset turns it off. The element changes as your CSS says, with its transitions. A state is a look: handlers, URLs and styles can't be set.
- focus @Field and blur move focus without typing.
- slide @Card to @Slot (or by 0,-48) moves an element by translate, on the house curve.
- zoom @Scene to @Card [scale=1.5] pushes in on part of the picture; zoom @Scene out comes back. @Scene is a wrapper inside the stage.
- scroll @List to @Row12 (or to 320) scrolls a list by moving its content up inside its parent, which needs overflow: hidden and a fixed height. The cursor moves over the list first.

## States are your CSS
- Write states in the artboard's <style>, with the transition on the base rule so it eases both ways: .send { transition: background-color .15s } .send:hover { … } .send:active { scale: .97 } .field:focus-within { … } .row[data-done] { … }.
- The scene plays your transitions. A state without one snaps: fine for a focus ring, rarely for anything else.
- Inline styles beat <style> rules: a state that changes something set inline needs !important.
- @keyframes on a state rule don't play in a scene: use transitions there, and show or count for entrances.

## Check it
1. screenshot shows the poster. It should tell the story on its own. Lint lists beats that can't play: a name nothing matches, a target that's off screen when the cursor goes for it, a loop with no reset.
2. record films a storyboard by default: one frame where each beat lands, labeled with the beat. Pass frames (12–16), or from and to, to film evenly instead and watch a fast stretch: a press, a grow, the reset.
3. Read the storyboard as a stranger: does each beat have a cause, does the payoff hold, does the loop end where it began?`;

export const KIT_GUIDE = `# Product shot kit

Parts at real geometry to start a product shot from. Paste them, then restyle to the product: its tokens, radius, type, accent and icons. Keep the geometry. Values here are a quiet light look; put them in tokens.

## Tokens
\`\`\`css
--color-canvas: #f6f5f4; --color-chrome: #fbfbfa; --color-surface: #fff; --color-well: #efeeec;
--color-line: rgba(0,0,0,.07);
--ink-1: rgba(0,0,0,.04); --ink-2: rgba(0,0,0,.06); --ink-3: rgba(0,0,0,.08); --ink-4: rgba(0,0,0,.1); --ink-5: rgba(0,0,0,.15);
--text-strong: #1d1d1f; --text: #3c3c43; --text-faint: #8a8a8e;
--color-accent: #3b5bfd; --color-accent-press: #2f4ae6; --color-accent-soft: #eef1ff;
--shadow-window: 0 0 0 1px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.08);
--shadow-hero: 0 0 0 1px rgba(0,0,0,.06), 0 30px 60px -12px rgba(50,50,93,.25), 0 18px 36px -18px rgba(0,0,0,.3);
--shadow-satellite: 0 0 0 1px rgba(0,0,0,.04), 0 14px 32px -8px rgba(50,50,93,.24), 0 4px 10px -4px rgba(0,0,0,.1);
--shadow-ground: 0 0 0 1px rgba(50,50,93,.06), 0 24px 48px -24px rgba(50,50,93,.18);
--radius-sm: 6px; --radius-md: 8px; --radius-lg: 10px; --radius-window: 12px;
\`\`\`
Dark: canvas #111113, surface #1a1a1d, inks rgba(255,255,255,.05 … .2), hero shadow 0 0 0 1px rgba(255,255,255,.08), 0 30px 60px -12px rgba(0,0,0,.6). Depth from lighter surfaces.
The hero window takes --shadow-hero, a card sitting on it --shadow-satellite, a lone surface --shadow-ground. Radii nest: outer = inner + padding.

## The stage
The picture goes inside a stage that fills the artboard and clips, so the hero can run off its edges without the artboard growing:
\`\`\`html
<div data-name="Stage" style="position:absolute;inset:0;overflow:hidden">
  … the window, at position:absolute, past the right and bottom edges …
</div>
\`\`\`

## A macOS window
A 38px title bar; the lights are 9px, 6px apart, their centers 19px from the top and the left.
\`\`\`html
<div data-name="Window" style="position:absolute;left:96px;top:96px;width:1080px;height:640px;display:flex;flex-direction:column;overflow:hidden;background:var(--color-surface);border-radius:var(--radius-window);box-shadow:var(--shadow-hero)">
  <div data-name="Title bar" style="display:flex;align-items:center;gap:6px;height:38px;flex:none;padding:0 14.5px;background:var(--color-chrome);border-bottom:1px solid var(--color-line)">
    <span style="width:9px;height:9px;border-radius:50%;background:#ff5f57;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)"></span>
    <span style="width:9px;height:9px;border-radius:50%;background:#febc2e;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)"></span>
    <span style="width:9px;height:9px;border-radius:50%;background:#28c840;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12)"></span>
    <div data-name="Title" style="flex:1;margin-right:36px;text-align:center;font-size:13px;font-weight:600;color:var(--text-strong)">Northwind</div>
  </div>
  <div data-name="Body" style="position:relative;flex:1;min-height:0">…</div>
</div>
\`\`\`
- A browser: in place of the title, an address field: \`<div style="flex:1;margin-left:8px;padding:4px 10px;border-radius:6px;background:var(--ink-1);font-size:10.5px;line-height:1.4;color:var(--text-faint);white-space:nowrap">dashboard.northwind.co</div>\`. Current Safari and Chrome draw it as a centered pill (border-radius 999px, about 40% wide). Browser chrome only when the browser is part of the picture.
- A sidebar app (Mail, Linear, Slack): the window is a row; a 180–220px sidebar on the canvas color runs the full height and holds the lights at the top (the same 38px row, no title bar over the content); the content column is the surface, its heading at the column's 16–32px inset.
- A terminal: one dark surface (#161618), dim centered title (\`northwind — zsh\`), monospace 12–13px lines, a prompt, status marks in color sparingly.

## An iPhone
The screen is 402×874 points with 64pt corners; the status bar is 54 tall, the island 95×37 at 14 from the top, the home indicator 144×5 at 8 from the bottom. Draw it at true points so its type stays iOS size (body 17, secondary 15), and scale the whole phone with transform; let it run off the stage rather than shrink it.
\`\`\`html
<div data-name="Phone" style="position:absolute;left:0;top:0;width:422px;height:894px;padding:10px;border-radius:74px;background:#1c1c1e;box-shadow:inset 0 0 0 1.5px #48484a, 0 30px 60px -12px rgba(0,0,0,.35);transform:scale(.85);transform-origin:top left">
  <div data-name="Screen" style="position:relative;width:402px;height:874px;border-radius:64px;overflow:hidden;background:#fff;font-family:-apple-system,system-ui,sans-serif">
    <div data-name="Status bar" style="position:absolute;left:0;right:0;top:0;height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 34px 0 52px;font-size:17px;font-weight:600;color:#000">
      <span>9:41</span>
      <span style="display:flex;align-items:center;gap:7px">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="#000"><rect x="0" y="7.5" width="3" height="4.5" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2.5" width="3" height="9.5" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
        <svg width="16" height="12" viewBox="0 0 16 12" fill="#000"><path d="M8 2.6c2.2 0 4.2.8 5.7 2.2l1.1-1.1A9.7 9.7 0 0 0 8 1 9.7 9.7 0 0 0 1.2 3.7l1.1 1.1A8.1 8.1 0 0 1 8 2.6Zm0 3.2c1.3 0 2.5.5 3.4 1.3l1.1-1.1A6.4 6.4 0 0 0 8 4.2 6.4 6.4 0 0 0 3.5 6l1.1 1.1A4.8 4.8 0 0 1 8 5.8Zm0 3.2c.5 0 .9.2 1.2.5L8 10.7 6.8 9.5c.3-.3.7-.5 1.2-.5Z"/></svg>
        <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="23" height="12" rx="3.5" stroke="#000" opacity=".35"/><rect x="2" y="2" width="20" height="9" rx="2" fill="#000"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="#000" opacity=".4"/></svg>
      </span>
    </div>
    <div data-name="Island" style="position:absolute;top:14px;left:153.5px;width:95px;height:37px;border-radius:18.5px;background:#000"></div>
    <div data-name="App" style="position:absolute;left:0;right:0;top:54px;bottom:0">…</div>
    <div data-name="Home indicator" style="position:absolute;bottom:8px;left:129px;width:144px;height:5px;border-radius:3px;background:#000"></div>
  </div>
</div>
\`\`\`
- Nothing sits under the island; a sheet starts below the status bar. On a dark screen the status bar, island ring and indicator turn white.
- A notification banner: inset 18 from the screen's sides, 14 17 14 14 padding, 23 radius, a 38×38 app icon (9 radius) 13 from 15pt text on 18pt lines, the title bold over its message; frosted rgba(252,252,253,.76) with backdrop-filter: blur(30px). On an unlocked phone it sits 56 from the top, under the island. Always true size: the phone is sized around it.
- Messages keep Messages' conventions unless the brief gives a look: blue sent bubbles, gray received, reactions on the bubble.
- On a phone use cursor touch, or no cursor: never a macOS arrow.

## Rows and filler
A list is rows; real words only on the rows the story touches.
\`\`\`html
<div data-name="Row" style="display:flex;align-items:center;gap:12px;height:56px;padding:0 12px;border-bottom:1px solid var(--color-line)">
  <span style="display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#e9d8c4;color:#7a5530;font-size:12px;font-weight:600">MC</span>
  <div style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0">
    <span style="font-size:14px;font-weight:500;line-height:1.3">Maya Chen</span>
    <span style="font-size:12px;line-height:1.3;color:var(--text-faint)">maya@northwind.co</span>
  </div>
  <span style="font-size:12px;color:var(--text-faint)">Admin</span>
</div>
<div data-name="Filler row" style="display:flex;align-items:center;gap:12px;height:56px;padding:0 12px;border-bottom:1px solid var(--color-line)">
  <span style="width:32px;height:32px;border-radius:50%;background:var(--ink-3)"></span>
  <div style="display:flex;flex-direction:column;gap:7px;flex:1"><span style="width:120px;height:7px;border-radius:4px;background:var(--ink-4)"></span><span style="width:164px;height:6px;border-radius:3px;background:var(--ink-2)"></span></div>
  <span style="width:44px;height:6px;border-radius:3px;background:var(--ink-2)"></span>
</div>
\`\`\`
- A bar replaces a line of text in the same line box: 7px for a title, 6px for secondary, rounded, var(--ink-3)/(--ink-4) on white. Widths vary row to row.
- Named avatars take their own muted color with initials; filler avatars are plain discs.
- A sidebar's filler nav items: a 14px rounded square and a 6px bar, 30px rows; the selected item is real, on an --ink-2 pill.

## Controls
\`\`\`html
<div class="field" data-name="Field" style="position:relative;display:flex;align-items:center;height:40px;padding:0 12px;border-radius:var(--radius-md);background:var(--color-surface);box-shadow:0 0 0 1px var(--ink-4)">
  <span data-name="Placeholder" style="position:absolute;left:12px;font-size:14px;color:var(--text-faint)">name@company.com</span>
  <span data-name="Value" style="font-size:14px">maya@northwind.co</span>
</div>
<div class="button" data-name="Send" style="display:flex;align-items:center;height:40px;padding:0 18px;border-radius:var(--radius-md);background:var(--color-accent);color:#fff;font-size:14px;font-weight:600">Send invite</div>
\`\`\`
\`\`\`css
.field { transition: box-shadow .2s ease; cursor: text }
.field:focus-within { box-shadow: 0 0 0 1px var(--color-accent), 0 0 0 4px rgba(59,91,253,.16) !important }
.button { transition: background-color .15s ease, scale .15s ease; cursor: pointer }
.button:hover { background-color: var(--color-accent-press) !important }
.button:active { scale: .97 }
\`\`\`
- A toast: a dark pill, 10px radius, 13px medium text with a 16px status glyph, --shadow-satellite, where the product puts it.
- A popover or menu: a surface with 4px padding, --radius-lg, --shadow-satellite, 28–32px rows with 6px-radius highlights inset from its edge; it opens from its trigger's side and stays a gutter from every edge of the stage.
- A pill or badge: 3px 8px padding, 999px radius, 12px medium text in a status color on its soft fill.

## Icons
Paste SVGs from one set (Phosphor, Tabler, Radix, Heroicons, Material Symbols, or the product's own) at one size, 14–16px, in one opaque color; filled at 14px and under. The cursor, caret and keycaps come with the scene: never draw them.`;
