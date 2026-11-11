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
time.ts           ages ("2 h", "3 weeks ago") and the clock they read
styles/           tokens.css (every token) and cloud.css (the Tailwind build)
ui/               primitives: buttons, icon, marks, menu, popover, tooltip, avatar, kbd, scroll area
window/           the window frame, chrome, page tabs, presence, Share, PR mark, next action, thread toggle
sidebar/          the sidebar: workspace menu, filter, rows, settled tray, search
create/           the create page: composer, model picker, repo picker, ideas
gallery/          dev-only: every board composed from fixtures, every component's states
```

`AppWindow` takes the sidebar, the chrome past its left block (`DesignChrome`, or nothing on the
create page), the rail's content (null while closed) and the canvas pane's content. The thread
rail, needs you, the pull request tab and settings plug into those slots.

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
- One way to style: the canvas keeps its own `pz:` build, and `studio.css` (the local app's)
  doesn't scan this folder.

## Adding a component

Name it for what it is in the product and give it the product's types (a row takes a
`DesignSummary`, not strings per pixel). Keep fixtures out of it. Give every control hover,
pressed, keyboard focus (`focus-ring`) and disabled states, a role and a name; build menus and
popovers on `ui/menu.tsx` and `ui/popover.tsx` so they keep their keyboard. Add it to
`gallery/states.tsx`, and if it is on a board, to that board's composition in
`gallery/boards.tsx` and `gallery/compositions.ts`. Pure rules get a `bun:test` beside them;
behaviour in a browser goes in `gallery/gallery.test.ts`.

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

`references` redraws `gallery/references/`, the pictures `gallery.test.ts` compares the
compositions against, with text hidden so they hold across machines' font rendering. Redraw them
when a change is meant to move pixels, and look at them before committing. The test needs Chrome
or Chromium (`PONZU_CHROMIUM`) and skips without one; without the app's web fonts it doesn't
compare.
