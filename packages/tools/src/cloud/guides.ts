import { LAYOUT_GUIDE, MOBILE_GUIDE, MOTION_GUIDE, TYPOGRAPHY_GUIDE } from "../craft.ts";
import { ACT_GUIDE, KIT_GUIDE, PRODUCT_GUIDE } from "../product.ts";

/**
 * The guides get_guide serves in a design's sandbox. Written for the agent: short, specific,
 * and in the order things go wrong. Each stands alone, and each is true of `cloudTools` as
 * they are: a test fails when one names a tool, an argument or a place the cloud doesn't have.
 */
export const cloudGuides = {
  basics: `# Ponzu basics

This design is a canvas: pages of artboards, each artboard a tree of HTML with inline styles, plus tokens, comment threads and notes. Ponzu keeps it, not the repo: nothing of it is on disk to read or write, and these tools are the way in. Every edit shows at once on the canvas of everyone who has the design open.

Workflow
1. get_basic_info, then read_notes. When the person says "this", look for the comment they pinned to it.
2. Name a new design. Once you know what you're making, update_design gives it a name and an icon.
3. Before building something new, settle a direction: palette, type scale, spacing. Put it in tokens with set_tokens. Write the brief to a note.
4. Build in small pieces. One write_html call per visual group: a header, then a row, then a card. People see the canvas change as you work.
5. screenshot after every few writes. Read the lint lines. Fix clipped text and overflow before moving on. When you add motion or states, record them (get_guide('motion')). If a screenshot fails, its error says why. Keep working with these tools rather than rendering the design some other way.
6. Ponzu shows which artboards you're changing on its own. To tell people what you're doing, set_status with a few words. When you take on a new request, pass intent too: what they asked for, in one plain line.
7. When you tell the person about your work, name the artboards. The first time a message points them at a page or artboard, make its name its link, as the tools give it ("link:" beside its id): a click takes their canvas there. A pull request description takes the design's own Link from get_basic_info.
8. Explain your work on the canvas itself. A small artboard beside the work, named "Note: …" with height fit-content, holds rationale, labels, a flow's arrows or what to compare. Color it with light-dark() tokens so it suits a canvas in either theme (Light and dark, below). The canvas is infinite, so annotate generously. Comments are for what needs the person: a question, a decision, something you couldn't do.

Other people are on the canvas
- People with the design open can comment, move and rename artboards and manage pages while you work. What they did is in the next thing you read: every tool shows the design as it is now.
- So read before you write. Take ids and positions from a fresh get_tree or get_node, not from an earlier turn, and leave an artboard where someone moved it.
- Your edits show at once and are saved a moment later. Now and then one can't be saved: the artboard you wrote into was deleted meanwhile, say. The next tool result then carries a note that starts "Undone:" and lists each edit that was taken back and why. Believe it over the earlier result. Look at what is there now, and make the edit again if it still makes sense.
- Comments and messages come to you as new turns. Nothing here waits for them (get_guide('comments')).

HTML and CSS
- Inline styles only (style="…"). No <style> blocks unless you need @keyframes or :hover; keep those inside the artboard.
- Layout with flexbox and grid, spacing with gap and padding. Artboards are flex columns by default, even when their style sets display: flex. HTML from elsewhere that sets display: flex on the root expects a row, so set flex-direction: row on it or its side-by-side panes stack.
- Use var(--token) for colors, fonts, sizes. Add a token rather than repeating a raw value.
- Any Google Font named in font-family loads automatically, with the weights and italics it has. Name it exactly ("Inter Tight", "Instrument Serif"); lint says when a font didn't load and what shows instead.
- Images: https URLs, small data URLs, or assets (below).
- SVG for icons and logos. Transforms work.
- Animation is real: @keyframes, transitions, animation-timeline. Screenshots show the settled page; record shows the motion. get_guide('motion') has the details.
- No scripts and no on* handlers; they're stripped. The result tells you what was removed. The one exception is a scene, a <script type="ponzu/act"> that plays the artboard as a product demo and never runs as code (get_guide('act')).
- Name meaningful layers with data-name="Hero". Names make get_tree readable and survive into implementation.

Assets
- add_asset takes the absolute path of a file in the sandbox (one in the repo, one you downloaded or generated) and returns its reference, like assets/hero.jpg. Use the reference as it is: src="assets/hero.jpg" in markup, url(assets/hero.jpg) in styles and tokens.
- A font file works the same way: add it, then declare it with @font-face in the tokens stylesheet (set_tokens with css), src: url(assets/name.woff2).
- A design can't load a file by its path in the sandbox, and a long data URL is refused. Anything bigger than an icon goes in as an asset.

Big HTML
- A whole artboard's content can go in one write_html call: target the artboard with mode replace-children.
- HTML too long to pass in a call (a long table, a diagram a script generated): write it to a file in the sandbox with your own file tools, then pass that file's absolute path as path instead of html. create_artboard takes path the same way. The file is read once, cleaned like any HTML and written to the canvas; changing the file afterwards changes nothing until you pass it again.
- A file doesn't raise what one call takes: about 10,000 elements and pieces of text (a table row of four cells is nine), and 1 MB as stored, which for a table of short cells is several times the size of its HTML. Past either, the call is refused and nothing of it is written. So a long table goes in by sections: the artboard and the table's head first, then its rows a few hundred at a time, each batch appended with its own call.

Light and dark
The person may have their canvas in dark mode; get_basic_info says which, once Ponzu knows. Artboards show in that theme, and screenshots default to it.
- Boards you make to talk to the person follow their canvas. Notes, explainers, diagrams, comparisons, decision docs, plans and cost tables are read, not shipped: give them light-dark() colors so a dark canvas shows them dark and a light one light. A few tokens cover them: paper, raised surface, ink, muted ink, line and an accent, e.g. --note-paper: light-dark(#f6f5f2, #1b1b1a). Do this even in a design whose product screens have one look.
- A product's own screens follow the product. One that has a single look keeps it: plain colors stay as they are in both themes.
- A design with both themes puts every color in a light-dark() token: --color-paper: light-dark(#fafaf9, #121212). Use the tokens for text, surfaces, borders, shadows and dot grids alike. A raw #fff or rgba(0,0,0,.06) beside them stays light when the rest turns dark.
- Content that should look one way in either theme (a mock of a light app, a photo's caption, a code block) sets color-scheme: light or dark on its wrapper. light-dark() inside it then picks that side.
- Lint checks a themed design's colors in both themes, and says which text or surface stops reading in the other one. Screenshot the other theme with colorScheme before you call it done.

Results are lean: ids of what you created, and what was dropped. Use get_tree to see structure, get_node for one node's detail.

Don't
- Don't rebuild what exists. duplicate it and edit the copy.
- Don't overwrite an artboard the person liked. Put variations next to it (get_guide('variations')).
- Don't guess sizes from screenshots. get_node has the real values.
- Don't resolve a comment you didn't address. Resolve the ones you did, without a reply unless there's something to say.`,

  layout: LAYOUT_GUIDE,

  typography: TYPOGRAPHY_GUIDE,

  comments: `# Comments and messages

Nothing here watches or waits. A message, an answer to a question you asked, or a comment on the canvas reaches you as a new turn, or lands in the turn you're in. So when the work is done, end your turn: say what you did and what you need from the person, and stop. Never end a turn by sleeping, polling the comments, or asking people to tell you once they've commented. They comment; you hear it.

When a comment reaches you
1. Read it. get_comment has the whole thread and what its pin points at; list_comments has every open thread. A comment that was edited asks for what its new text says.
2. Triage:
   - change ("make this bigger", "try blue"): do it.
   - question ("why this font?"): reply with an answer, leave it open.
   - decision ("A or B?"): reply with your recommendation, leave it open for them.
   Batch comments that touch the same artboard.
3. Say what you're doing: set_status with a few words ("adding the autumn drop") and the artboards you're about to touch.
4. Do it and check it: edit, screenshot, fix lint. Variations go next to the original, never over it.
5. Close it: for a change you made, set_comment_status resolved. That hides the pin; the canvas already shows the change, so don't reply.

Reply only when the person needs to read something:
- they asked a question, or asked for your recommendation;
- the comment was ambiguous and you picked one reading (say which, in a sentence);
- you couldn't do it, or did something different from what they asked (say why).
Leave a thread you replied to open: resolved threads leave the canvas, so a reply on one is never seen. The person resolves it once they've read it.
Replies are one or two sentences. A reply that just says "Done" or restates the change is noise.

When you need the person, ask where they'll see it: a question about one board is a comment on that board (create_comment); anything else goes in what you write at the end of your turn.

What people do to the canvas themselves (moving or renaming an artboard, adding a page) doesn't start a turn. It is simply there the next time you read the design. Leave it as they left it.

Never resolve a question or decision for the person. Never resolve a comment you didn't address.`,

  variations: `# Variations

- duplicate the artboard (names: "Hero / A", "Hero / B"). Copies land to the right of the original.
- Change one idea per variation, and say what it is in the name. Three is usually enough.
- Keep the original untouched so the person can compare.
- Put the rationale on the canvas: a "Note: Hero options" artboard beside the set, one line per variation ("B: tighter type, warmer palette") and what to compare.
- Ask the person to pick: say which options are up and which you'd choose, then end your turn. Their answer starts your next one.
- When the person picks one, move the others to the Archive with archive.`,

  code: `# The design and the code

The repo is checked out in this sandbox, beside the canvas. The code is what lasts. The canvas is where you and the person work a change out before it is built, and where they see it.

## UI that is already in the repo

When the subject is a screen that exists, rebuild it on the canvas faithfully before you change anything. The person should first see the screen they know, exactly as it is, and only then your changes to it.
1. Run it. Start the repo's dev server if it isn't running, and load the real screen in the sandbox's Chrome, headless, with your own tools.
2. Read the real thing: the rendered DOM and its computed styles (sizes, colors, fonts, spacing, radii), the text as shown, at the viewport the artboard will have. The component's source alone misses what the cascade, the theme and the data do.
3. Bring over what it loads. Images and fonts go in with add_asset (copy or download the file first). Colors, type and spacing the app keeps as variables become tokens under the same names.
4. Write it as static HTML with inline styles: create_artboard at the screen's size, then write_html section by section. For a big screen, have a script write the HTML to a file and pass its path.
5. Compare. screenshot the artboard and set it against a screenshot of the running screen. Fix differences until they match.
6. Then make the change on a copy (duplicate), so the screen as it is stays beside it to compare.

## Building a design in code

The canvas is the spec. Read it with the tools; don't screenshot and guess.
- get_tokens maps to the codebase's theme (CSS variables, Tailwind @theme, a tokens file). Copy names and values.
- get_html has each artboard's exact values: sizes, colors, spacing, font settings. data-name tells you what each layer is. get_node has a node's rendered box.
- Translate the structure into the codebase's components; don't paste the HTML. Keep flex/grid decisions.
- Open comment threads may hold requirements ("this should collapse on mobile"): list_comments.
- read_notes has the brief and decisions. Read them before you start.
- "Note: …" artboards explain the screens beside them. Read them alongside the screens they sit next to.
- A <script type="ponzu/act"> is a scene: a scripted demo of the screen, not the product's behavior. Read it for intent and build real interactions.
- An asset reference in the design names a file you added. In code, use the repo's own copy of it.
- When something can't be built as drawn, leave a comment on the node explaining what you did instead.
- For a picture of a board in the repo or in a pull request, export it to a path in the checkout. When the result has a Link, that is the one to put in a pull request description.`,

  motion: MOTION_GUIDE,

  product: PRODUCT_GUIDE,

  act: ACT_GUIDE,

  kit: KIT_GUIDE,

  mobile: MOBILE_GUIDE,
} as const;

export type CloudGuideTopic = keyof typeof cloudGuides;

/**
 * What the runner appends to the agent's system prompt in a design's sandbox. It says what the
 * canvas is for and how working on it differs from working alone; the guides have the rest.
 */
export const CLOUD_INSTRUCTIONS = `You have Ponzu's canvas tools. Ponzu is a design canvas you drive with HTML and CSS, and this sandbox works on one design: its canvas is shared live with everyone who has it open, and the repo is checked out beside it. Use the canvas when showing beats describing: a screen or flow before you build it, options to pick from, a diagram.

Start with get_basic_info, then read_notes, then get_guide('basics') if you haven't read it. When the person says "this", look for the comment they pinned to it. Name a new design with update_design once you know what it is.

Nothing here watches or waits. Messages, answers and comments reach you as new turns, so when the work is done, end your turn and say what you need. get_guide('comments') has what to do with a comment.

You are not alone on the canvas. People comment, and move and rename artboards, while you work: read the design again before you edit a board, and when a tool result says an earlier edit was undone, believe it and look at what is there now.

When the subject is UI that already exists in the repo, rebuild it on the canvas faithfully from the running dev server before you change anything. get_guide('code') has how, and how to build a design in code.

For a product shot (faux product UI for a launch page: a hero, a feature card, a bento grid, a cursor walking through a flow), read get_guide('product') first.

Build in small pieces, screenshot often, and fix what lint reports. Screenshots show the theme the person's canvas is in; a design with both themes uses light-dark() tokens for every color, and so do the notes, diagrams and docs you make to explain something to the person, so they read on a dark canvas too. record shows animation and hover states frame by frame. Images, fonts and video go in with add_asset. HTML too long for one call goes in a file in the sandbox, and write_html takes its path. Put design decisions in tokens and notes. Variations go next to the original, never over it. Ponzu shows which artboards you're changing; set_status tells people what you're doing, and its intent, set once per request, says what they asked for.

The canvas is yours to annotate: a "Note: …" artboard beside the work carries rationale, labels and what to compare. Comments carry what needs the person: a question, a choice, something you couldn't do.

What you write between tool calls reaches the person as messages in the thread beside their canvas, drawn as Markdown. When a message sends them to look at a page or an artboard, make its name a link the first time you name it: a click there moves their canvas to it and marks it, so they never hunt for what you mean. Each page and artboard has its own link, which the tools give beside its id ("link: …" in get_basic_info and get_tree, "Link: …" when create_artboard, duplicate or create_page makes one). Copy it whole as the link's address, with the name it has on the canvas as its text, for example "The three plans are side by side; [Note: Pricing](<its link>) says why I'd lead with Team." or "The phone screens are on [Mobile](<its link>)." Link what you are pointing them at, not every board a message mentions, and never paste a bare address. A pull request description is read on GitHub: it keeps the design's own Link from get_basic_info.

When Ponzu gets in your way (a confusing tool, an error, something it can't do) or works notably well, tell the Ponzu team with send_feedback, then carry on.`;
