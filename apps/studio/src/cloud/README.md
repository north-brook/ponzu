# The cloud app's UI

The Mac app's main window for Ponzu Cloud, as components driven by props: no data fetching, no
API, no Electron. The data layer maps the API and live queries onto the types in `model.ts` and
passes them in. The local app's screens beside this folder are deleted at cutover.

```
model.ts          the product's concepts as the UI takes them (export these to fakes)
status.ts         a row's indicator and its precedence, the rail toggle's signal, ordering
filter.ts         the sidebar filter
search.ts         match highlighting, keyboard selection over results
pull-request.ts   the next action and the pull request mark's state
time.ts           ages ("2 h", "3 weeks ago"), durations, a time of day, and the clock they read
gate.ts           what keeps someone from steering a design (read access, the owner's Claude), in words
claude.ts         the person's Claude: how it is connected, its plan's limits, a pasted code
styles/           tokens.css (every token) and cloud.css (the Tailwind build)
ui/               primitives: shadcn/ui's components themed with our tokens (button, menus,
                  popover, tooltip, dialogs, field, command, tabs, avatar, kbd, skeleton…), the
                  product's names on them (menu.tsx, modal.tsx, TextField), our own few (icon, ladder,
                  marks, fade-scroll, qr), and Prose, which draws untrusted Markdown
                  (markdown.ts has its rules)
window/           the window frame, chrome, page tabs, presence, Share, PR mark, next action, thread toggle
sidebar/          the sidebar: workspace menu, filter, rows, settled tray, search
create/           the create page: composer, model picker, repo picker, ideas; a send's travel
                  to the thread and its beat (flight.ts, landing.ts)
thread/           the thread rail: its lines, a running turn's asides and the working line, and
                  what leaves when it ends (thread.ts has the rules, thread-view.tsx the motion),
                  following the foot, the composer, drafts, the keyboard on opening (rail.tsx)
needs-you/        what the agent waits on, in the composer's place, and the rules for answering it
pr-tab/           the pull request tab: details, checks, conversation, files and their diffs
setup/            guided first run: the gates (setup.ts), sign in, where you design, Connect
                  Claude and its card, the iPhone step
settings/         the Settings modal and its sections, with their rules (billing, members,
                  environments)
dialogs/          what a send can need first: a card, a higher cap, Claude again; and the
                  account's confirmations
gallery/          dev-only: every board composed from fixtures, every component's states
```

`AppWindow` takes the sidebar, the chrome past its left block (`CanvasChrome`, or nothing on the
create page), the rail's content (null while closed) and the main pane's content. `ThreadRail`
is the rail's content, needs you included; `PullRequestView` fills the main pane while the pull
request tab is open. Settings plugs in the same way.

### Three zones

The window is three zones, and the chrome's two dividers mark them: the sidebar is navigation,
the thread rail is the conversation with the agent, and everything between the dividers belongs
to the middle (the page tabs and the pull request tab on its left, presence, Share, the pull
request mark and the next action on its right, and below them what the chosen tab shows).
Choosing the pull request tab swaps what the middle shows and nothing else: the rail stays as it
was (open at its width or closed, its scroll, its draft, its working state), so does the
sidebar, both toggles and ⌘B, ⌥⌘B keep working, the chrome reads as on any page, and no pane
moves. The tab sits over the canvas in the same rounded pane; the canvas waits underneath,
`inert` (the canvas takes no keys while it is, and ⌘Z on the read-only tab is taken in
`canvas-panes.tsx` so Edit › Undo doesn't reach into the thread's draft), and a page tab brings it back where it was:
page, position, zoom and selection. The tab fits whatever width the middle has: details over
files in one column at a reading measure below 1080, the board's two columns from there
(`Columns` in `pr-tab/pull-request-view.tsx`).

The sidebar and the rail resize by dragging their edge with the canvas. The panes are shadcn's
Resizable (`ui/resizable.tsx`, react-resizable-panels) in pixels, with their limits in
`window/panes.ts`; `AppWindow` takes the widths to open them at and hands back a new one (the
window keeps it in `app/ui-state.ts`). The edge is the gutter between pane and canvas, so it never
covers either. The toggles collapse and expand the same panels, easing while `data-pane-motion` is
on the window; a drag never eases. Anything that lines up with a pane's edge (the chrome's blocks)
reads its width from `--pane-sidebar` or `--pane-rail`, which a drag writes in the frame the panes
move in, and eases with the `pane-motion` utility beside a `transition-[…]` naming what moves:
`pane-motion` eases only while `data-pane-motion` is on, so nothing tagged with it trails a drag.
Dragging one edge holds the other pane still (its panel disabled) and stops where the main pane
reaches 400. Whenever the window lays the panes out itself (opening, a toggle, a window resize),
each open pane takes its remembered width, or in a window too small for both a share of the
shortfall (`fitPanes`); what's remembered changes only when the person moves an edge.

### The window chrome

The chrome departs from the boards on purpose, at the founder's request: it draws no Ponzu
lockup in any state, the sidebar toggle is the first thing at the left (on a Mac 8px past the
traffic lights, which the shell puts at x 16, y 16, so the toggle's box spans 76 to 104 and is
centred on the lights' line; on Windows and Linux 10px from the edge), and the thread toggle is
the last thing at the right, 10px from the window's edge, whether the rail is open or closed and
on every tab. The chrome is 38px tall where the boards draw 44 (the founder's direction: more
compact, its 28px controls and the traffic lights centred on it), so everything under it sits 6px
higher than on a board. `visual.ts compare` masks the boards' 44px of chrome for these reasons,
so the rest is still checked against the boards.

The chrome reads, left to right (the founder's order), the right side the left's mirror:

- sidebar collapsed, a design open: `[traffic lights] [sidebar toggle] [canvas name] | [tabs] +`.
  The name is the row's type (13, medium), cut with an ellipsis at 240, and not a control: a
  double-click there zooms the window, as on any Mac title bar, so renaming stays on the row.
- sidebar open: `[traffic lights] [sidebar toggle]` … `| [tabs] +`, the divider on the
  sidebar's edge, where the main pane starts (its pixel the canvas's first column). The name's
  room closes to nothing.
- rail open: `[people] [PR mark] [action] | …  [thread toggle]`. The cluster (presence and
  Share's +, the pull request mark, the next action) sits over the canvas and ends 12 before the
  divider; the divider is on the rail's edge, its pixel the canvas's last column; the chrome over
  the rail is empty to the toggle.
- rail closed: `[people] [PR mark] [action] | [thread toggle]`, together at the window's edge,
  12 either side of the divider. The pull request tab leaves the rail as it was, so it reads as
  on any page: open or closed by the rail.
- the create page, or no design: `[traffic lights] [sidebar toggle]` and nothing else: no
  name, no divider.

Each divider's place comes from its pane's width, which the panels write to `--pane-sidebar` and
`--pane-rail` as they lay out (app-window.tsx, a drag included): the left block and the rail's
block in the chrome (`[data-chrome-rail]`) read them, so one number moves pane and divider. Where the
window is too narrow for all of it (the smallest window, five people and Update branch) the page
tabs give way, scrolling under their fade; the cluster never wraps or clips.

### What comes after the first paint

Nothing on a page moves when data arrives, and the chrome holds to it. Opening a design, its
parts come from different answers: the name, the repo (and so the people's cluster) and the pull
request's number, state and checks are on the sidebar's row, there at once; the pages come with
the design's document, the people here and the agent's state with presence and the head (live
queries, each sealed by the API before Realtime answers), and the action button with a read of
GitHub through the API (`pullRequest`). In that order of preference, each is:

- **Not late.** The mark is drawn from the row until the head comes (the same columns, with what
  the last read said of whether it can merge), so the head confirms it without a change. The
  pull request's read is TanStack Query's, kept half an hour (`gcTime`), and the design's store
  starts from it, so a design opened again shows its action from the first frame while the read
  on opening confirms it; the read goes out as the design opens, not after its head. Until that
  read answers, the kept answer is offered only while it agrees with the row and the head (the
  same number, state and checks: `offeredTab`), so a pull request merged or closed while the
  design was away never offers Merge; otherwise its room is held as on a first opening. The
  pointer resting on a row, or the keyboard stopping on it, for 80 ms asks for that read ahead
  (`onIntent`, `prefetchQuery`), and the read on opening stands on an answer under ten seconds
  old.
- **Room held.** While the row says the pull request is open or a draft, the room its likely
  action takes (`nextAction` on the row's summary) is held unseen (`ActionRoom`), so the mark
  stands where it will; the action fades into it, and only if its words differ does the room
  ease to their width while they fade in. Where the row itself comes only after the first paint
  (a launch), the held room opens with the mark on the same clock rather than appearing whole.
  No skeleton bars in the chrome.
- **Arriving on purpose** (`window/arrival.tsx`). What can't be known ahead arrives as one
  movement on the panes' clock (`--dur-pane`, `--ease-out`): its room opens from its still edge
  (the cluster's right, the name's left), what is beside it glides aside once, and it fades in,
  rising 2 px, starting a fifth of the way in. Pieces that come in one answer move together;
  pieces that come apart don't restart each other (a room changing mid-movement goes on from
  where it is; a room inside another that is opening, a person joining, carries it rather than
  both easing). An action that becomes another while shown (Ready becoming Create PR) arrives in
  place of it, the new words fading in as the room eases (`swap`). Leaving is the same gesture
  back: it fades and sinks, its room closes. The pages and the new-page + only fade, since
  nothing beside them moves. Someone joining the people opens
  their own room; those who were there at the first paint are simply there. A design opened anew
  is a new chrome: what it has at once shows at once, never as an entrance, so switching between
  two designs replays nothing they both have. Under reduced motion nothing eases or travels, and
  the end state is there at once. An entrance never holds back what is ready: the room starts
  opening in the frame the answer lands, and into a room already held the action starts fading
  in that frame too.

The pull request tab, opened while its read is on its way, shows its skeleton and then settles
what GitHub said in over it (`settle`); opened with the last answer kept, it is simply there.
The gallery's `canvas-opening` and `canvas-opening-launch` draw a design opening with its answers
late, delivered on demand (`window.galleryArrive`, or `?later` on a schedule);
`gallery/arrivals.test.ts` steps each arrival on its own clock (`stepArrival` in
`scripts/visual-lib.ts`) and holds every piece that was on screen to a pixel, but the designed
movement, whose start and end it checks. `app/opening.e2e.test.ts` opens designs in the app with
every answer slowed and checks what the first frame shows.

⌘B toggles the sidebar and ⌥⌘B the rail, from anywhere in the window, the canvas and the
composers included (no field here takes rich text, so ⌘B means nothing else); both are in the
toggles' tips and in the desktop's View menu (Toggle Sidebar, Toggle Thread), whose clicks
reach the studio as commands. Neither toggles while a menu or a modal is open over the window,
or while a design's name is being edited on its row (`paneHeld` in `ui/shortcut.ts`).

Both panes open and close on one clock, `pane-motion` (`--dur-pane`, `--ease-out`), and so does
everything that moves with them: the pane's width, the main pane's margin, the left block's
width, the name's room, and the rail's block in the chrome, so each divider stays on its pane's
edge in every frame (the rail's until the edge passes where it rests with the rail closed). The
rail, like the sidebar, keeps its content still at the window's edge while its room opens or
closes, and holds it until it has closed. The boards view
keeps its boards still on screen as its pane's edge moves, anchored to the edge that isn't
moving, with no refit (useCanvas.ts). `gallery/chrome.test.ts` checks it frame by frame, and
the app's end-to-end test that the boards don't move.

The focus ring is keyboard navigation's and nothing else's (`ui/quiet-focus.ts`, installed once
by the app and the gallery). It shows where Tab or Shift-Tab, or an arrow, Home or End inside a
menu, a list, the page tabs or the people in the chrome, moved focus, and again where focus comes
back to something navigation had reached (a menu or dialog closing onto its trigger) with no
click since. Focus a click gave, a shortcut acted through, or our own code handed on (a question
taking the composer's place, a row back from renaming) is marked quiet for as long as it stays,
whatever keys follow: ⌘, ⌥ held for a shortcut, Return, Space, a letter. It turns into the
keyboard's only when a navigating key is pressed on it. `focus-ring` and the canvas package's
controls skip quiet focus, and so do tips (`Tip`). Return or Space on a control that has the
keyboard's focus hands it on: the popover or dialog it opens rings its first control (`presses`);
on a control a click focused, the same press stays quiet. Text fields keep their own focus treatment;
menus show their current item by its highlight, whichever way they were opened.

Controls that act on the window, not on themselves, take no focus from a click at all, as a
Mac's toolbar buttons don't (`data-toolbar`: the chrome's toggles and page tabs, and the
sidebar's Search and New design), so the next key goes where it went before the click. Search
gives focus back where it found it when it closes (the composer after ⌘K, nowhere if it was
nowhere), as the keyboard's if it was.

Text from the model or GitHub (replies, plans, a pull request's body and comments) goes through
`Prose`, never `dangerouslySetInnerHTML`. It is react-markdown with GitHub's flavour (tables, task
lists, strikethrough, bare addresses; not footnotes, whose parser is slow on stray `]`s and whose
in-page links we drop, so `[^1]` reads as written) and GitHub's line breaks, drawn into our
elements: raw HTML stays text (no rehype-raw), images become links so nothing loads by itself, a
link survives only to http, https or mailto and opens outside the app, except one to a design's
own address with a page or board on it (`canvas-address.ts`), which in an open design's thread
moves the canvas there (`place-link.tsx`: dotted where an outside link is solid, muted once what
it names is gone). While a reply streams, a link still being written shows as its words alone
(`settled`). Text shaped to make the
parser slow (see `parseable` and `parts` in markdown.ts), or longer than 32 KB, is plain text.
Blocks are memoised in runs of 16, so a reply streaming in parses only its last run.

## Keyboard

| Shortcut | What it does | Where |
| --- | --- | --- |
| ⌘N | New design (the create page) | sidebar, File menu |
| ⌘K | Search (expands a collapsed sidebar first) | sidebar |
| ⌥⌘B | Show or hide the thread; opened, the caret is in its composer | thread toggle |
| ⌘P | Show or hide the pull request | pull request mark |
| ⌘⇧↵ | Press the action button (Create PR, Ready, Merge…) | action button |
| ⌘, | Settings | sidebar, app menu |
| ⌘1–⌘8, ⌘9 | Open the sidebar's first eight designs, and ⌘9 its last | sidebar |
| ⌘0 | The create page | sidebar |
| ⌃1–⌃8, ⌃9 | Open the design's first eight pages, and ⌃9 its last | page tabs |
| Esc | Close search, a menu or a popover | |

Off the Mac, Ctrl stands for ⌘ and Alt for ⌃. The design numbers are the 1.x studio's; pages
moved from ⌥ to ⌃, which types nothing (`ui/shortcut.ts`):

- **Which list.** ⌘ numbers follow the sidebar's active designs as it shows them, filtered and
  ordered; settled designs aren't counted. While search's results take the list's place, ⌘1–9
  rest (⌘0 still works). With the sidebar collapsed they open the same designs, unseen. ⌃ numbers
  follow the page tabs. 9 is always the last, however many there are.
- **Hints.** Holding the modifier on its own for 250 ms shows each target's number
  (`ui/shortcut-hint.tsx`): on a row, over its preview's top-left corner; on a page tab, in its
  icon's place, or on a tab without one in place of its name, which fades beneath it.
  Nothing moves to make room. They arrive one after another on the pop's timing and leave all at
  once, quicker, as the key comes up, the window loses focus, or any other key, click or scroll
  comes; so ⌘B, ⌥⌘B or ⌘K never flash them. A number pressed while they show keeps them up.
- **When not.** Nothing jumps or shows while a menu, popover or dialog is open. In a text field
  (the composer, search, a rename) ⌘ and ⌃ numbers still jump, since they type nothing, but show
  no hints; off the Mac, Alt numbers neither jump nor show there.
- **⌘0.** The desktop's View menu has no zoom roles, so ⌘0 is never Actual Size (`menu.ts`).

The thread and the pull request's keys:

- **Opening the thread** (its toggle, ⌥⌘B, View › Toggle Thread, from the canvas or the pull
  request tab) puts the caret in its composer once the pane has opened (it is `inert` until
  then), without scrolling the thread or showing a ring; with a question in the
  composer's place, on its first option. Not under a menu, popover or dialog, not from a field
  elsewhere that has the caret (search, a rename), and not when the pane comes with a design
  being opened. Closing it with the keyboard inside gives the keyboard back to where it was.
  So a canvas key (C for a comment) right after opening the thread types in the composer.
- **⌘P and ⌘⇧↵** do what a click on the pull request mark and the action button does, from
  anywhere, the composer included (⌘↵ there is still Send, ⇧↵ a new line). Neither takes the key
  under a menu, popover or dialog, nor is counted there; ⌘⇧↵ never while the button is faded
  (blocked, Auto-merge on) or busy, and once a press however long the keys are held. Merging
  past the repo's rules still asks first. The desktop's menu has neither accelerator, and no
  Print.

The create page's keys and caret:

- **The caret goes to the composer** (`create/focus.ts`, `focusCreateComposer`, once the page
  has drawn) after New design (its button, ⌘N), after a workspace is switched to from the
  sidebar's menu, and after another workspace's Scratch or repo is chosen in the picker; only
  when the create page is what shows: not where the workspace opens on a design, not under a
  menu, popover or dialog, and not while a send is under way. Settings' own switcher leaves it.
- **After a choice** in the project picker or the model menu, the caret goes back to the
  composer (`after` on `RepoPicker` and `ModelPicker`), to go on typing; closed without one
  (Escape, a click away), focus goes back to the trigger as any menu's does.
- **The model menu's two panes**: Up, Down, Home and End move within a pane and stop at its
  ends; Left and Right move between them, onto the other's chosen row (Right goes nowhere when
  the model takes no effort); Return or Space chooses. A model keeps the menu open, an effort
  closes it.

## Tokens

- Style with Tailwind utilities that name a token, and nothing else: `bg-surface`, `text-muted`,
  `rounded-8`, `shadow-pop`, `text-13`. cloud.css clears Tailwind's own palette, radii and
  shadows, so a raw color utility does nothing. Sizes and spacing may be arbitrary values copied
  from the design (`h-[34px]`).
- Every color is a `--c-*` in `styles/tokens.css`, written `light-dark(light, dark)`. The app
  follows the system appearance; `data-theme="light" | "dark"` on `<html>` pins one. Where the
  design gives no dark value the file says "derived".
- A new token goes in tokens.css, in cloud.css's `@theme inline`, and, for a size, radius or
  shadow, in `ui/cn.ts` so tailwind-merge knows it.
- Icons are Hugeicons (`@hugeicons/core-free-icons`, MIT) through `ui/icon.tsx`, at a step of the
  ladder (below), never a size and stroke by hand; color them with a text token. Brand marks are
  in `ui/marks.tsx`.
- Motion: durations and easings are tokens; reduced motion stills every animation.
- Fonts: `vite.config.ts` links the web fonts into every page (the app and the gallery) from one
  URL; a new family or weight goes there, so the gallery always measures what ships.
- What is open or chosen (the open row, the selected result, the open "+") takes `bg-selected`,
  not `bg-canvas`: in dark the black canvas would read as a hole in the shell.
- The grounds, at the founder's direction: the canvas (`--c-canvas`) is pure white or pure black,
  the canvas package's ground too; the shell round it is a little tinted, and on a Mac a little
  glassy. `--c-chrome` is the solid shell (a browser, the gallery, Windows and Linux, Reduce
  Transparency) and `--c-chrome-glass` the tint laid over the Mac's window material, which the
  shell says it has over the bridge (`glass`, from apps/desktop/src/shell-ground.ts). Paint the
  shell with `bg-shell`, never `bg-chrome`: over the glass only `<html>` paints the tint, once.
  Raised things on the shell (the composer, cards, menus, popovers) stay solid. `bun
  scripts/glass-shots.ts <dir> [ids]` draws compositions solid and over a stand-in for the glass.
- One way to style: the canvas keeps its own `pz:` build, and `studio.css` (the local app's)
  doesn't scan this folder.

## The ladder

Every icon and every piece of interface text is set from a few named steps, so a call site says
what a thing is rather than how big it is: `<Icon icon={…} step="control" />`, `TEXT.meta`. The
steps are in `ui/ladder.ts`; the icon steps live with the canvas (`@ponzu/canvas/ladder`), so its
tools and zoom are drawn from the same table. The gallery's `?ladder` draws them all, and
`bun scripts/ladder-sheets.ts <dir> --ladder` draws every composition in light and dark at 2x
beside it.

**Icons.** Size and stroke move together. Hugeicons draw on a 24-unit grid, so a stroke `s` at
`size` px paints `s × size / 24` px; each step's stroke is chosen so all of them paint the same
line (1.0–1.1 px), and a small icon reads at the weight of a large one.

| Step | Size / stroke | Where |
| --- | --- | --- |
| `control` | 16 / 1.7 | alone in a 24–28px button (the chrome's toggles, the sidebar's Search, Filter and New design, the composer's +, the canvas's tools and zoom), or leading a menu's, a nav's or a list's row |
| `inline` | 14 / 1.9 | inside a compact control beside 13px words: a page tab, a check in a list, a field's glyph, the 28px send arrow |
| `small` | 12 / 2 | beside 12px words: a quiet button's project, the action button, a status line, a submenu's chevron |
| `meta` | 11 / 2.2 | beside 11px words: the meta line's repo, branch and pull request; a header's chevron; a link's arrow |
| `tick` | 10 / 2.4 | inside a dense mark: a check that passed, a checked box, a remove ✕ |

`onFill` draws a step 0.4 heavier where the icon sits on a solid ground (the send arrow on yuzu,
the action button's glyph, a checked box): a light line on a fill reads thinner than ink on
paper. An icon alone that belongs to a row of text controls takes the row's step: the page tabs'
+ is `inline`, like the tabs' icons. The slice, avatars and brand marks are drawn, not stroked,
and keep their own sizes. There is one plus, Hugeicons' `PlusSignIcon` (the canvas's `plus`):
`Add01Icon` draws a smaller cross in the same box, so beside the zoom's + it read lighter
(ladder.test.ts holds this).

**Text.** A size, a weight and a face; colour comes from the role below unless the step is
defined by being quiet.

| Step | Treatment | Where |
| --- | --- | --- |
| `body` | 13 | what a person reads: messages, a dialog's words |
| `name` | 13 medium | a design's, a page tab's, a setting's name |
| `title` | 13 semibold | the heading of a small surface: the workspace, a dialog's row |
| `control` | 12 medium | a button's words (quiet muted, raised ink, action semibold on ink) |
| `secondary` | 12 | a line under a name (faint) or a value at rest (muted) |
| `meta` | 11 mono, faint | repo, branch, pull request, counts, ages |
| `label` | 11 semibold, faint | a section's label in a menu, Settings, search, the pull request tab |

Display (Funnel Display 600) is a heading's alone: 28 a setup step and the create page's
statement (its project selector included), 26 the pull request, 18 a Settings section, 40 a
price.

The full-window pages read one size up, as the boards draw them: setup's lede is 15 muted and its
cards' names 14 medium, and the Share popover's heading is 14 semibold. The create composer's
field is 16, and its model and effort a step under it, 14. The canvas's comment cards
are on the ladder too: a message is `body` (13), its author and age `secondary` (12).

**Colour, by role.** `ink` is what is read, chosen or open (body text, the chosen tool, the active
tab and its icon); `muted` a control at rest and a secondary line; `faint` quiet text (meta,
placeholders, labels, counts), deliberately under AA; `icon-soft` a quiet icon standing alone (a
disclosure chevron, a field's glyph, a row's trailing action, Settings' close), one step above
faint so it holds 3:1. An icon beside words takes the words' colour (a tab, a chip, the meta
line): it is part of that label. The one exception is a row's leading icon in a menu or a nav, which
is muted beside ink words so the words lead.
Disabled is not a colour: a disabled control fades to 35%. The accents mean one thing each: yuzu
the agent at work; `pr-open`, `pr-running`, `pr-conflict`, `pr-failing`, `pr-merged` a pull
request's state; `danger` what can't be undone or failed.

Kept apart on purpose: the canvas's tools are the pane's instruments, so the chosen one is ink on
a raised chip while the rest stay muted; the meta line is the faintest text in the app; the
action button is the one semibold control.

## Adding a component

Start with shadcn/ui. If it has the element, add it from apps/studio:

```sh
bun run shadcn add <component>          # e.g. sonner, or several at once; --overwrite to update one
```

That runs `shadcn add` (components.json: new-york, Tailwind v4, Hugeicons, files in `ui/`) and
then makes its files ours: their `cn` comes from `ui/cn.ts` (which teaches tailwind-merge our
token scales) rather than the `cn` package, siblings are imported by relative path, and the
dependencies we replace (`cn`, `lucide-react`, `tw-animate-css`) are taken back out. It ends by
listing every class in the new files that still names shadcn's theme, a bare `border` with no
color beside it (Tailwind v4's is currentColor, an ink hairline here), a `dark:` variant (it
follows only the system, not a pinned `data-theme`, and our tokens already hold both themes) and
shadcn's `disabled:opacity-50` (ours is 35). Map each one onto our tokens, swap any lucide icon
for `ui/icon.tsx` at the design's size, and drop shadcn's `[&_svg]:size-4` rules (they override a
Hugeicon's own size). The new-york v4 registry ignores `iconLibrary` for some items (checkbox
still imports `CheckIcon` from lucide-react), so the script's lucide warning is expected: the
file won't typecheck until the icon is swapped. `styles/shadcn-names.test.ts` fails on any left
behind.

Then build the product's piece on it. Name that for what it is in the product and give it the
product's types (a row takes a `CanvasSummary`, not strings per pixel); where shadcn's API
differs from what callers use, keep the product's names in a wrapper (`menu.tsx` over
`dropdown-menu.tsx`, `modal.tsx` over `dialog.tsx`, `TextField` over `input-group.tsx`). Keep
fixtures out of it. Give every control hover, pressed, keyboard focus (`focus-ring`) and disabled
states, a role and a name. Add it to `gallery/states.tsx`, and if it is on a board, to that
board's composition in `gallery/boards.tsx` and `gallery/compositions.ts`. Pure rules get a
`bun:test` beside them; behaviour in a browser goes in `gallery/gallery.test.ts`. Guided setup,
Settings and the dialogs keep theirs in the `setup-*` files of `gallery/`, which those registries
spread in.

### shadcn's names, our tokens

The added files are edited to name our tokens; shadcn's semantic variables are not defined. Two
of its names are already ours with another meaning (`muted` is a text color here, a ground
there), and the design gives each surface its own radius and shadow (a menu 12, a popover 14, a
tip 7, a dialog 16), which shadcn's one `--radius` can't say, so aliasing them would either
repaint something or say what isn't so. The usual swaps:

| shadcn                                            | ours                                           |
| ------------------------------------------------- | ---------------------------------------------- |
| `bg-popover`, `bg-background`, `bg-card`          | `bg-surface` (`bg-raised` for a raised chip)   |
| `text-popover-foreground`, `text-foreground`      | `text-ink`                                     |
| `text-muted-foreground`                           | `text-muted`, or `text-faint` for labels       |
| `bg-muted`                                        | `bg-chip`                                      |
| `focus:bg-accent`, `data-[selected=true]:bg-accent` | `data-[highlighted]:bg-hover`, `…:bg-hover`  |
| `bg-primary`, `text-primary-foreground`           | `bg-action`, `text-action-ink`                 |
| `bg-destructive`, `text-destructive`              | `bg-danger` / `text-danger-ink`, `text-danger` |
| `bg-border`, `border-input`                       | `bg-rule`, `shadow-field`                      |
| `focus-visible:ring-[3px] ring-ring/50`           | `focus-ring` (a field: `focus-within:shadow-field-focus`) |
| `bg-black/50` (a dialog's overlay)                | `bg-dim`, `bg-dim-dialog`                      |
| `rounded-sm`…`rounded-xl`                         | the design's: `rounded-7`, `-8`, `-12`, `-14`, `-16` |
| `shadow-md`, `shadow-lg`                          | `shadow-pop`; a tip `shadow-tip`               |
| `text-xs`, `text-sm`                              | `text-11`, `text-12`, `text-13`                |
| `animate-in fade-in-0 zoom-in-95 …`               | `pop` (menus, popovers, dialogs), `tip`        |
| `animate-pulse`                                   | `breathe`                                      |

### What is ours, and why

- `fade-scroll.tsx`: the Mac keeps the system's thin native scrollbar and fades a cut edge;
  shadcn's scroll-area draws its own bars over Radix's.
- The window chrome, the sidebar's rows, the composer, presence, the pull request's diff view:
  the product's own layouts, not UI elements a library has.
- The needs-you options list and the thread's follow-the-foot logic: shadcn's newer
  questionnaire and message-scroller parts are the path once they settle; they are too young to
  build on now.
- `qr.tsx` on uqr, and Hugeicons through `icon.tsx`: what the design specifies.
- AI Elements (now shadcn/ui's own patterns): none are used. The thread has no fold since the
  founder asked for a plain one, so Chain of Thought (and the Trace and Collapsible it was built
  on) went with it. The rest stay ours: Chat and Message Scroller (the follow-the-foot logic
  above; ours also windows a thousand lines and anchors by hand), Message and its Bubble (the
  design's bubble, avatars and comment frames), the streaming response (`Prose`, with its rules
  for untrusted Markdown), Tool and Reasoning (the thread never shows a tool's input or output,
  and Claude Code's thinking isn't streamed to it), the shimmer utility for the working line (the
  design draws the turning slice, not a sweep of light), and Prompt Input (the composer, the
  product's own).
- `window/arrival.tsx`, what comes after the first paint (above): a room whose width at rest is
  `auto`, which a CSS transition can't ease from or to, so it is the Web Animations API, from the
  width before to the width after, measured in the same layout. Its animations are named
  (`arrival-room`, `arrival-content`) so a test can step them.
- A comment's picture in the thread is a glance at where it was left, not the message: 144 by 96
  (three fifths of the 240 by 160 it is drawn at, so a 2x screen has more pixels than it needs),
  a tall one cut at 108 from its middle, corners 10 with the one meeting the bubble tucked to the
  bubble's 5, a hairline (2) above its words, the same at every rail width (`commentPictureSize`
  in `thread/lines.tsx`).
- A finished turn's asides and the working line leaving: a CSS keyframe on the pane's clock
  (`leave` in cloud.css), each line kept for its last frame at exactly the room it held, while
  the rail's own scroll anchoring keeps the reader's place. Not a library's exit animation:
  only the rail knows where a line sat and what the reader is anchored on.
- The create page departs from board 5 (fresh start) on purpose, at the founder's direction:
  Ponzu's mark (the slice, 56) over one statement in the display face at 28 stands where the
  question was, "Make something in" over "owner/name ⌄" on a second line, or "Make something
  from scratch ⌄" on one, whose last words are the project selector, about making rather than
  designing; the ideas are not tiles under the composer but take turns as its placeholder
  (`create/ideas.tsx`: each for `SUGGESTION_DWELL_MS`, the one before lifting away as the next
  rises in), put away by typing and taken into the field with Tab, to edit and send; and the
  page sits on the canvas's dotted ground (`canvas-dots`, the same dots the canvas draws under
  its boards with `--pz-dot`), since this is where a canvas starts. The dots are
  `--c-canvas-dot`, 13% ink in light and 15% white in dark (the founder found 8% and 9% too
  subtle), the same size and spacing, on every canvas. Nothing on the page moves when ideas
  arrive or don't.
- The project selector is the statement's last words, not a chip under the composer (the
  founder's direction): the display face at 28 in ink with the owner and slash faint so the name
  leads, then a `control` chevron in `icon-soft`. A repository takes a line of its own under
  "Make something in", centred under it; Scratch ends the one line, on its baseline (the
  founder's direction: "the project selector in a second line, except for the scratch case").
  The statement keeps two lines' room either way (`STATEMENT_ROOM`, the 35 line over the 40
  selector) with its first line at the top, so the mark and the first line hold still whichever
  is chosen. A long label stays on one line no wider than the statement's 660, the owner giving
  way first. The trigger draws no folder; the picker's rows keep theirs. While the window's repos
  load the selector holds the second line with a skeleton, never saying scratch before it knows,
  and when it resolves (to Scratch or a repo) nothing above it moves. With the selector a line
  lower, the picker in a window at the app's smallest shows a little less than five and a half
  rows, and scrolls.
- The create page's layout (the founder's direction), with its measures in `create/create.ts`:
  the composer is docked at the foot of the main pane, centred at its 660, 10 above the pane's
  edge (`DOCK_INSET`, the distance the thread's composer keeps from the rail's foot, so a send
  travels nearly level: the main pane ends 6 above the window's edge, so the two feet are 6
  apart), and grows upward with what is typed or attached. The hero (the mark over the
  statement) has its centre 5% of the pane's height above the pane's true centre (`HERO_RISE`:
  45 in a pane of 900, so it scales with the window; the founder found the room's centre too
  high and the pane's exact centre too low), and holds still as the composer grows. Only once
  the composer would come within 40 of the statement does the statement rise ahead of it; the
  mark fades once that would take it within 24 of the pane's top, and the statement stops there,
  the pane scrolling rather than let the two overlap (`heroPlace`). No window the app allows is
  that short: at the smallest, with the field grown to its most, the whole hero still has its
  room.
- The model picker in the create composer departs from the boards (the founder's direction): the
  chip (Claude's mark, the model, the effort faint) reads 14 beside the field's 16, a step down
  the ladder, its mark 14. Its menu is two panes side by side with a hairline between, opening
  upward from the docked composer, its end on the chip's: the models on the left (the pane fits
  the longest name between 152 and 232, a longer one cut short with its whole name in its
  title), the efforts the chosen model takes on the right (128). Choosing a model keeps the menu
  open, since the effort may be what comes next; choosing an effort closes it with the caret back
  in the composer. A model that takes no effort says "None for this model" in the right pane (the
  menu's description to assistive tech), shows its name alone on the chip, and closes the menu
  when chosen. Each pane is a radio group named by its label. `create/model-picker.tsx`.
- A send from the create page (the founder's direction; `create/flight.ts`, `create/landing.ts`).
  The moment it goes, before the API answers: the hero fades where it stood (the page keeps its
  width as the pane narrows), the design's view comes (its chrome with the name it will have,
  the main pane on the same dotted ground, and the thread's pane opening whatever it was left
  as, with the sent words as its first line and the agent waking), and the composer travels from
  the foot of the main pane to its home at the foot of the thread, changing size on the way.
  It is one card that moves: its surface, its + and its send button (which keep their corners
  and become the thread's +, and Stop in its place); what was written keeps the width it was
  written at and fades in the first third, the thread composer's words fade in over the last
  two fifths, and nothing reflows. The travel is 1.75 of the panes' clock (385 at `--dur-pane`
  220), on `--ease-travel`, a relative of `--ease-out` that starts from rest: it begins with the
  pane opening and lands once the pane has settled, so it reads as the pane making room and the
  composer going home. It lands empty with the caret in it; the design the API makes takes the
  launch's place under it (anything typed meanwhile, and the caret, carried over). After
  `LANDING_BEAT_MS` (1400) the thread's pane closes on its usual easing and that is remembered as
  the toggle would; it stays open, remembered so, if since the send the person moved the pointer
  into it, pressed, focused, typed or scrolled there, and the toggle or ⌥⌘B pressed then is the
  person's say. Only a send from the create page has a beat; another design opened, or the
  create page again, before it ends leaves the pane closed. A send that fails comes back to the
  page as it was (words, images, project, the caret in the field), the error said, and nothing
  travels back; a second press while it goes does nothing. With reduced motion nothing travels
  or eases and it ends the same. A window resized or a pane's edge taken hold of mid-way lands
  it at once. Not the View Transitions API: tried first, its travelling thing is two pictures
  stretched into one box and cross-faded (`flight.ts` says why in full).
- With the thread's pane closed after the beat, the thread toggle in the chrome says what the
  agent is doing in the pane's place (`window/thread-toggle.tsx`, `railSignal`): the count of
  questions waiting on the person (yuzu), the turning slice while it works, a dot once it has
  said something since the pane was last open (an answer, or a turn that failed or stopped); and
  the design's row in the sidebar says the same. Nothing opens the pane by itself.
- The repo picker departs from board 5 (pick a project) on purpose: one-line rows at the menus'
  metrics, each titled `owner/name` with the owner quieter (no owner heading, no line under
  Scratch), and Scratch's dashed-folder icon from `ui/project-icons.ts`, the one place both
  projects' icons are set. With one workspace it is Scratch, then the repos the person can push
  to, pushed-to lately first, with no heading. With several (at the founder's direction: Scratch
  in any of them), it is a group for each usable workspace, the window's first and then the
  others in the switcher's order: the workspace's name as a menu's section label (shadcn's
  command group, `CommandGroup` in `ui/command.tsx`, whose heading is `menuLabelClass`, the
  menus' rule between groups), its own Scratch, then its repos (`pickerGroups` in
  `create/create.ts`). The headings and Scratch rows come with `me`, so they show at once; a
  workspace's repos come from the same workspace query, one per workspace, through `useQueries`
  in `app/main-window.tsx`, and join its group when they arrive. One that fails still offers its
  Scratch. An open list never moves under the pointer: only the last group's repos join while
  it is open, at the foot (a placeholder row keeps their place); any other group keeps what it
  had as the picker opened, and repos that arrive meanwhile show the next time it opens
  (`heldWhileOpen`). The list has a search whenever it would scroll, counting headings and the
  rules between groups (`listHeight`, `searchAtOpening`), or while the last group's repos are
  still to come, settled as it opens. Search matches anywhere in `owner/name`, "scratch" finds
  every Scratch, and with several workspaces a workspace's name finds its Scratch and its repos;
  a heading shows only over a group with a match. The arrows move over the rows and pass the
  headings by, which name their groups for assistive tech. Choosing another workspace's Scratch
  or repo switches the window to that workspace with its create page open and that project
  chosen, handing the words, images and picked idea over (`CreateHandoff` in `app/create.tsx`)
  in the same render. The selector then reads Scratch (the sidebar says whose) and its label
  says it, `Project: Scratch in Lenny Learning`. Allow more on GitHub acts for the window's
  workspace. Its composition masks the picker and says so in `compare`. The picker never moves
  the page: its list shows five and a half rows and scrolls, and in a window too short even for
  that the list gives up height and the picker stays under its selector. A name cut short shows
  whole in a tip past the picker's right edge, or its left where the window has no room on the
  right.

### When you need

- a toast: the first one is `bun run shadcn add sonner`;
- a form of several validated fields: shadcn's field (`FieldSet`, `FieldGroup` and the rest of
  `bun run shadcn add field --diff`), not a forms library;
- a long list: `@tanstack/react-virtual`.

A surface over the whole window (Settings, a dialog) is built on `ui/modal.tsx`: it traps focus,
closes on Escape and on the dim, and starts focus on itself so nothing shows a ring until the
person moves it. A field being edited inside one takes Escape for itself with
`data-keeps-escape`.

## The gallery and the visual check

```sh
cd apps/studio
bun run gallery                 # opens /gallery.html: ?board=<id>, ?states, &theme=dark
bun scripts/visual.ts compare --canvas <path to the .design folder>
bun scripts/visual.ts references
```

`compare` draws each composition and the design's own board at the board's size in light and
dark, and writes ours, theirs, the difference and the pair to `.context/visual`, with the share
of pixels that differ, overall and outside the regions this code doesn't draw (the canvas's
boards, the thread rail). The design file is not in the repo.

`references` redraws `gallery/references/`, what `gallery.references.*.test.ts` compares the
compositions against, two ways:

- a picture of each in light, with its text hidden so it holds across machines' font rendering.
  It catches layout: a moved row, a changed gap, where a popover lands. Dark has no picture: the
  themes differ only in colors, shadows and a theme's own pictures, which the styles hold
  exactly. A composition marked `reference: "styles"` has no picture either, because another
  composition's picture holds its layout.
- `<id>-<theme>.styles.txt` in both themes, the styles it paints with (`paintedStyles`): every
  text's color, weight, size and family, every icon's color, size and stroke, every image and the
  file it shows, every ground and shadow. It catches what is too small for the picture's
  tolerance: a changed text or icon token, a wrong `text-*` class or weight, the wrong theme's
  picture. A failure prints the lines that changed.

Redraw them when a change is meant to move pixels or styles, and read the diff before
committing. The test needs Chrome or Chromium (`PONZU_CHROMIUM`) and skips without one; without
the app's web fonts it doesn't compare the pictures (the styles don't depend on them).
