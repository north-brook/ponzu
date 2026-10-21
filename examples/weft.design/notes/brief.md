# Weft — brief

**Weft is the sync layer for local-first apps.** A client SDK (`@weft/client`) keeps a local store in sync across devices and users: writes land locally in under a millisecond, queue in an op log while offline, and merge conflict-free (CRDTs) when the device reconnects. Behind it: an edge WebSocket gateway in 14 regions, a sync service, a rules engine, hosted Postgres-compatible storage with change-data-capture, presence, and the `weft` CLI.

Name: in weaving, the weft is the thread that runs across the warp and binds it into cloth. Weft runs across your clients and binds their state into one.

## Personality
Precise, calm, a little dry. An engineer's engineer: shows the numbers, ships the code sample first, never says "revolutionary". Writing reads like a good changelog.

## Visual direction: "loom and signal"
- Two grounds. **Paper** (warm off-white #F4F2EC) for marketing and docs, **Loom** (warm near-black #121210) for code, the product and terminals. Never pure white or pure black.
- **Signal orange** #FF5A1F is the one loud color: the weft thread, live sync, primary actions. Used sparingly.
- Secondary data hues (cobalt, teal, amber, plum) are reserved for presence cursors, charts and diagram zones.
- Motif: the woven thread. Horizontal lines that pass over and under vertical ones; thin 1px rules; dotted grid paper. Diagrams look like engineering drawings.
- Mark: a W drawn as the warp with an orange weft woven through it (over, under, over, under).

## Type
- Schibsted Grotesk for display and text (700 display with -0.04em tracking, 400/500 text).
- JetBrains Mono for code, labels, numbers, eyebrows (uppercase, +0.08em).
- Scale: 11 / 12 / 14 / 16 / 20 / 28 / 40 / 56 / 80 / 128.

## Spacing and shape
- 4px base. Sections 96–128px apart on the site; 24/32px inside cards.
- Radii are small and machined: 3 / 5 / 8 / 12. Pills only for status.
- 1px hairlines (--color-line) over shadows. Shadows only on floating UI.

## Syntax theme ("Loom")
keyword #FF8A5C · string #B9D98C · function #8FB0FF · type #E9C46A · number #D8A2F2 · property #7FD8C4 · comment #6F6C63 on #121210.

## Facts used across the file
- Local write p50 0.3 ms; edge fan-out p50 38 ms, p99 112 ms (same region); 14 regions; 99.99% SLA.
- Regions: iad, ord, sfo, gru, lhr, fra, ams, sto, bom, sin, nrt, icn, syd, jnb.
- Customers: Halyard (logistics), Penstroke (whiteboards), Fieldkit (offline field forms), Rallypoint (team scheduling), Ledgerly (bookkeeping), Cadence (music collab).
- Pricing: Hobby free (1k MAU), Pro $25/mo + $0.02 per MAU over 10k, Scale custom.
