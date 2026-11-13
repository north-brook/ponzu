# @ponzu/email

Ponzu's emails as React Email templates. The plan is `email.md` in the build program's plans (outside this repository); docs/cloud.md gains an "Email" section when the send path lands.

- `src/words.ts` holds every fixed sentence. `expected/<fixture>.txt` pins each fixture's subject, preview and text part, so a change to what an email says shows up in the diff. After changing words on purpose, run `PONZU_UPDATE_EXPECTED=1 bun test packages/email` and read the diff.
- `src/render.ts` renders an email to `{ subject, preview, html, text }`. The API sends those strings through its mail seam (`apps/api/src/deps/mail.ts`), so `resend` stays imported by one file. Rendering is deterministic: every date and amount comes in as a finished string.
- Only `@ponzu/api` depends on this package. It never imports `@ponzu/canvas`, `@ponzu/render`, `@ponzu/server`, `@ponzu/db` or `resend`, and `apps/mobile` never imports it (`src/surface.test.ts`).
- `bun run --cwd packages/email preview` opens React Email's preview server on the entries in `emails/` (written by `scripts/previews.ts`, one per fixture).
- `bun run --cwd packages/email shots` draws `references/<fixture>.png` in headless Chromium: light and dark at 390 and 720 px, and a forced inversion. Never merge these by hand: take main's and draw them again.
- `bun packages/email/scripts/print.ts <fixture> [--html]` prints one email.

Pins: `react-email` 6.11.5 and `@react-email/ui` 6.11.5, with `@react-email/render` held at 2.2.0 by the root `overrides`. `@react-email/ui` (the preview server, which brings Next.js) is a root devDependency, so the API's filtered install on Vercel does not fetch it. `@react-email/components`, `/tailwind` and `/preview-server` are deprecated and not used.
