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
                  product's names on them (menu.tsx, modal.tsx, TextField), our own few (icon,
                  marks, fade-scroll, qr), and Prose, which draws untrusted Markdown
                  (markdown.ts has its rules)
window/           the window frame, chrome, page tabs, presence, Share, PR mark, next action, thread toggle
sidebar/          the sidebar: workspace menu, filter, rows, settled tray, search
create/           the create page: composer, model picker, repo picker, ideas
thread/           the thread rail: its lines, following the foot, the composer, drafts
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

`AppWindow` takes the sidebar, the chrome past its left block (`DesignChrome`, or nothing on the
create page), the rail's content (null while closed) and the canvas pane's content. `ThreadRail`
is the rail's content, needs you included; `PullRequestView` fills the canvas pane while the pull
request tab is open (the rail folds away, and comes back as it was on leaving). Settings plugs in
the same way.

### The window chrome

The chrome departs from the boards on purpose, at the founder's request: it draws no Ponzu
lockup in any state, the sidebar toggle is the first thing at the left (on a Mac 8px past the
traffic lights, which the shell puts at x 16, y 16, so the toggle's box spans 76 to 104 and is
centred on the lights' line; on Windows and Linux 10px from the edge), and the thread toggle is
the last thing at the right, 10px from the window's edge, whether the rail is open or closed and
on every tab. The rest of the right cluster (presence, Share, the pull request mark, the next
action) sits just before the thread toggle, so it holds one place too, and the divider sits 18px
before the cluster in every state: it separates the page tabs from the cluster rather than marking
the rail's edge, so a wider cluster (five people, Update branch) or the rail toggling never moves
it off its partner.
`visual.ts compare` masks the chrome's 44px for this reason, so the rest is still checked
against the boards.

Text from the model or GitHub (replies, plans, a pull request's body and comments) goes through
`Prose`, never `dangerouslySetInnerHTML`. It is react-markdown with GitHub's flavour (tables, task
lists, strikethrough, bare addresses; not footnotes, whose parser is slow on stray `]`s and whose
in-page links we drop, so `[^1]` reads as written) and GitHub's line breaks, drawn into our
elements: raw HTML stays text (no rehype-raw), images become links so nothing loads by itself, a
link survives only to http, https or mailto and opens outside the app. Text shaped to make the
parser slow (see `parseable` and `parts` in markdown.ts), or longer than 32 KB, is plain text.
Blocks are memoised in runs of 16, so a reply streaming in parses only its last run.

## Keyboard

| Shortcut | What it does | Where |
| --- | --- | --- |
| ⌘N | New design (the create page) | sidebar, File menu |
| ⌘K | Search (expands a collapsed sidebar first) | sidebar |
| ⌘J | Show or hide the thread | thread toggle |
| ⌘, | Settings | sidebar, app menu |
| ⌘1–⌘8, ⌘9 | Open the sidebar's first eight designs, and ⌘9 its last | sidebar |
| ⌘0 | The create page | sidebar |
| ⌥1–⌥8, ⌥9 | Open the design's first eight pages, and ⌥9 its last | page tabs |
| Esc | Close search, a menu or a popover | |

Ctrl stands for ⌘ off the Mac, and Alt for ⌥. The numbers are the 1.x studio's
(`ui/shortcut.ts`):

- **Which list.** ⌘ numbers follow the sidebar's active designs as it shows them, filtered and
  ordered; settled designs aren't counted. While search's results take the list's place, ⌘1–9
  rest (⌘0 still works). With the sidebar collapsed they open the same designs, unseen. ⌥ numbers
  follow the page tabs. 9 is always the last, however many there are.
- **Hints.** Holding the modifier on its own for 250 ms shows each target's number
  (`ui/shortcut-hint.tsx`): on a row, over its preview's top-left corner; on a page tab, in its
  icon's place, or on a tab without one in place of its name, which fades beneath it.
  Nothing moves to make room. They arrive one after another on the pop's timing and leave all at
  once, quicker, as the key comes up, the window loses focus, or any other key, click or scroll
  comes; so ⌘B, ⌘J or ⌘K never flash them. A number pressed while they show keeps them up.
- **When not.** Nothing jumps or shows while a menu, popover or dialog is open. In a text field
  (the composer, search, a rename) ⌘ numbers still jump, since ⌘ types nothing, but show no
  hints; ⌥ numbers neither jump nor show, since ⌥ types symbols there.
- **⌘0.** The desktop's View menu has no zoom roles, so ⌘0 is never Actual Size (`menu.ts`).

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
- Icons are Hugeicons (`@hugeicons/core-free-icons`, MIT) through `ui/icon.tsx`, at the design's
  size and stroke; color them with a text token. Brand marks are in `ui/marks.tsx`.
- Motion: durations and easings are tokens; reduced motion stills every animation.
- Fonts: `vite.config.ts` links the web fonts into every page (the app and the gallery) from one
  URL; a new family or weight goes there, so the gallery always measures what ships.
- What is open or chosen (the open row, the selected result, the open "+") takes `bg-selected`,
  not `bg-canvas`: in dark the canvas is too close to the chrome to show.
- One way to style: the canvas keeps its own `pz:` build, and `studio.css` (the local app's)
  doesn't scan this folder.

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
product's types (a row takes a `DesignSummary`, not strings per pixel); where shadcn's API
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
- The idea tiles have no loading state (onboarding 4.6: nothing while they are made). On a
  first visit the column sits at the top from its first frame, where the ideas will go, and they
  rise into that room when they come; if none do, nothing moves.

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
bun scripts/visual.ts compare --design <path to the .design folder>
bun scripts/visual.ts references
```

`compare` draws each composition and the design's own board at the board's size in light and
dark, and writes ours, theirs, the difference and the pair to `.context/visual`, with the share
of pixels that differ, overall and outside the regions this code doesn't draw (the canvas's
boards, the thread rail). The design file is not in the repo.

`references` redraws `gallery/references/`, what `gallery.test.ts` compares the compositions
against, two ways:

- a picture of each, with its text hidden so it holds across machines' font rendering. It catches
  layout, grounds and shadows: a moved row, a changed surface.
- `<id>-<theme>.styles.txt`, the styles it paints with (`paintedStyles`): every text's color,
  weight, size and family, every icon's color, size and stroke, every ground and shadow. It
  catches what is too small for the picture's tolerance: a changed text or icon token, a wrong
  `text-*` class or weight. A failure prints the lines that changed.

Redraw them when a change is meant to move pixels or styles, and read the diff before
committing. The test needs Chrome or Chromium (`PONZU_CHROMIUM`) and skips without one; without
the app's web fonts it doesn't compare the pictures (the styles don't depend on them).
