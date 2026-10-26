# Ponzu press kit

What a journalist, partner or anyone writing about Ponzu needs: a description and the facts, logos, product shots, social images, and where to reach the project. Opens on the canvas at https://ponzu.design/gh/north-brook/ponzu/design/press-kit.design.

## Using it
- Every artboard on Logos, Product shots and Social is a finished asset at its real size, named for its download. Export one with Ponzu's `export` (PNG at 2x by default) or from the canvas.
- The app icon artboard is the shipped master, `apps/desktop/build/icon-1024.png`, on a transparent ground.

## Source of truth
- Facts and copy: `README.md` and `apps/web` (the home page, `components/share.ts`, `app/layout.tsx`, the download page, the privacy page). The iPhone app: `docs/mobile.md` and `apps/mobile`. Nothing here is invented: no stats, funding, founders or quotes.
- Logo geometry: `packages/react/src/slice.ts`. The lockup: `apps/web/components/icons.tsx`. Colors and type: `design/brand.design`.
- Product shots: the current Mac app itself. The canvas shots must be captured from it; the old `apps/web/public/app-light.png` and `app-dark.png` were stale and unused by the site, so don't take shots from them. The example-design shots come from `apps/web/public/home/*`.

## Open
- **Press contact: TODO.** None is published. See `notes/press-contact.md`.
- **Canvas shots need a recapture.** `ponzu-canvas-light` and `ponzu-canvas-dark` (`assets/app-light.jpg`, `assets/app-dark.jpg`) predate the rebrand: they show the old lemon mark and lettered comment pins. Recapture both from the current Mac app, light and dark, at 1600px wide, and replace the two JPEGs. Running the app takes a separate machine, so it wasn't done here.
