# Ponzu design system

The studio's own UI vocabulary, documented: the title bar with its tabs, shortcut hints and update button, the canvas's floating bars, buttons, toggle groups, tooltips, menus, comment pins and thread card, artboard labels with an agent's working state (yuzu rain, the ring, a new board's frame), selection and loading, the home screen's cards and controls, and the icons. Each shown in light and dark.

This is documentation of what ships, not a redesign. When the code changes, update these artboards to match; when they disagree, the code is right.

## Source of truth
- Canvas colors and motion: `packages/react/src/styles.css` (`--pz-*`, `.pz-ring`, `.pz-rain`, `.pz-shimmer`, `.pz-juice` / `.pz-juice-slow`, `.pz-hint*`).
- Components: `packages/react/src/ui.tsx` (Button, ToggleGroup, Tip, Menu, ShortcutHint), `Canvas.tsx` (bars, page tabs, artboard labels, `WorkingStatus`, `Ring`, `Frame`, the selection box, the opening state, pins), `arrive.ts` (a new board's frame, sheet and name), `Comments.tsx` (thread card, composer), `working.tsx` (`Juice`, `Rain`).
- Studio chrome: `apps/studio/src/Studio.tsx` (title bar, tabs, agents), `apps/studio/src/components/update.tsx` (update button and popover), `apps/studio/src/components/dashboard.tsx` (home screen), `apps/studio/src/components/file-info.tsx` (a card's where-line), `apps/studio/src/studio.css`.
- Icons: `packages/react/src/icons.tsx` and `icon-names.ts`, drawn from `@hugeicons/core-free-icons`. The SVG paths here are copied from that package.

## Notes
- `tokens.css` holds the brand tokens plus `.ui-light` and `.ui-dark`, the studio's two palettes as `--c-*` variables. Components here are written once and read whichever scope wraps them.
- Comment pins are yuzu with ink numbers and a faint ink hairline.
- The solid and segmented toggle-group variants exist in `ui.tsx` but nothing on the canvas uses them today; they're shown and marked as such.
- Home-card previews in `assets/` are the website's home-screen tile images (`apps/web/public/home`).
