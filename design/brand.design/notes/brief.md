# Ponzu brand

Ponzu's identity guidelines: the slice, the lockup, the app icon, color, type, motion and voice. Published so anyone (and any agent) building for Ponzu draws from one source, and to dogfood the GitHub viewer: this folder opens on the canvas at https://ponzu.design/gh/north-brook/ponzu/design/brand.design.

## Source of truth
Where this file and the code differ, the code wins. Update this file to match.
- The slice: `packages/react/src/slice.ts` (`SLICE`, stroke 3.4).
- Canvas colors, pins, trace and loader: `packages/react/src/styles.css`.
- Web colors, the lockup's hover: `apps/web/app/globals.css`.
- The lockup: `apps/web/components/icons.tsx`.
- Fonts: `apps/web/app/layout.tsx` (Inter, Funnel Display, IBM Plex Mono).
- App icon: `apps/desktop/build/icon-1024.png`, copied here as `assets/app-icon.png`.

## The system in one breath
- One mark, one color at a time: ink on light and on yuzu, yuzu on dark.
- Yuzu `#FFC81E` on warm neutrals, ink `#111110`. Yuzu fills; it is never text on light (1.6:1 on white). Rind `#7A4F00` is yellow's text color.
- Yuzu means Ponzu is present and something is happening: comment pins (yuzu, ink count, faint ink hairline), the agent's trace, the loader, CTAs on dark, the stage behind product shots. Selection is ink.
- Inter for UI, Funnel Display for display and the wordmark (Bold, −5%), IBM Plex Mono for code.
- Motion moves whole segments: turn one (60°, 600ms), ratchet (a 60° turn and a rest, 1.2s), trace (six dashes, 9.6s lap), bloom (3.2s).
- **Ponzu** in sentences, **ponzu** in the wordmark, `ponzu` in commands.

## History
The exploration that settled these choices (rejected directions, before/after shots) isn't checked in. This file is the published result only.
