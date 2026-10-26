# Ponzu brand

Ponzu's identity guidelines: the slice, the lockup, the app icons, color, type, motion and voice. Published so anyone (and any agent) building for Ponzu draws from one source, and to dogfood the GitHub viewer: this folder opens on the canvas at https://ponzu.design/gh/north-brook/ponzu/design/brand.design.

## Source of truth
Where this file and the code differ, the code wins. Update this file to match.
- The slice: `packages/react/src/slice.ts` (`SLICE`, stroke 3.4).
- Canvas colors, pins, the ring, rain, shimmer and loader: `packages/react/src/styles.css` (`.pz-ring`, `.pz-rain`, `.pz-shimmer`, `.pz-juice`).
- Rain and the loader as components: `packages/react/src/working.tsx` (`Rain`, `Juice`). The ring and the board header: `packages/react/src/Canvas.tsx` (`Ring`, `WorkingStatus`).
- How work arrives (the develop): `packages/react/src/arrive.ts`.
- The studio's chrome (home button, file tabs, home search, update button): `apps/studio/src` (`Studio.tsx`, `studio.css`, `components/update.tsx`, `components/dashboard.tsx`).
- Web colors, the lockup's hover: `apps/web/app/globals.css`.
- The lockup: `apps/web/components/icons.tsx`.
- Fonts: `apps/web/app/layout.tsx` (Inter, Funnel Display, IBM Plex Mono).
- Mac app icon: `apps/desktop/build/icon-1024.png`, copied here as `assets/app-icon.png`.
- iPhone app icon: `apps/mobile/assets/icon.png`, copied here as `assets/iphone-icon.png`. Its own master: the ink slice on full-bleed yuzu, no corners; iOS masks it.

## The system in one breath
- One mark, one color at a time: ink on light and on yuzu, yuzu on dark.
- Yuzu `#FFC81E` on warm neutrals, ink `#111110`. Yuzu fills; it is never text on light (1.6:1 on white). Rind `#7A4F00` is yellow's text color.
- Yuzu means Ponzu is present and something is happening: comment pins (yuzu, ink count, faint ink hairline), an agent at work (the ring round its board, rain, the develop's outlines), the loader, the update button, the home search's focus ring and caret, CTAs on dark, the stage behind product shots. Selection is ink.
- Inter for UI, Funnel Display for display and the wordmark (Bold, −5%), IBM Plex Mono for code.
- Motion: the slice moves whole segments: turn one (60°, 600ms), ratchet (a 60° turn and a rest, 1.2s), bloom (3.2s). An agent at work is rain (columns falling at their own pace, 1.05–1.55s), a ring breathing every 1.5s, and the develop (outlines first, 600ms, then each piece uncovered top down by 1300ms; a new board draws its frame first). A band of light (shimmer, 1.8s) sweeps the name of a working page tab, file tab or home card.
- Loading on the canvas is the slice turning (`Juice`). The studio's file tabs use a plain grey spinner instead, not the slice: a row of loading tabs would be a row of logos (`apps/studio/src/Studio.tsx`, `FileTab`).
- The studio's home button is the slice in `currentColor`: muted like the other tabs, ink (rice in dark) once Home is open.
- **Ponzu** in sentences, **ponzu** in the wordmark, `ponzu` in commands.

## Naming clash: rind
In code, `--pz-rind` (`packages/react/src/styles.css`) and the studio's `--rind` (`apps/studio/src/studio.css`) are yuzu, `#ffc81e`: the color an agent's work is drawn in. In this brand, rind is `#7A4F00`, yellow's text color. Same word, different colors. Read the hex, not the name. Noted only; the code is unchanged.

## Not on the Mac
The iPhone app's canvas still marks a working board with the old six-dash trace (`.pz-trace`, 9.6s lap, in `apps/mobile/canvas/canvas.css`). The Mac's canvas uses the ring and rain.

## History
The exploration that settled these choices (rejected directions, before/after shots) isn't checked in. This file is the published result only.
