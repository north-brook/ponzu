# Halon — brief

**Concept.** Halon is incident response and reliability for engineering orgs. Alerts arrive from Datadog, Prometheus Alertmanager, Sentry and 60+ sources; Halon dedups and routes them, pages the right on-call responder, opens an incident with a live timeline, runs coordination in Slack or Teams, keeps the status page honest and turns every incident into a postmortem and reliability data (MTTA, MTTR, SLOs, error budgets).

The name: halon is the gas that puts out fires in data centers without damaging the hardware. Calm, fast, precise suppression.

**Personality.** The steady voice on the bridge call. Confident, terse, exact. Never cute during an outage. Respect for the engineer at 3:12 a.m.

## Palette
- **Ink** `#0D1014` (and ink-2/3/4 for raised dark surfaces): the product's night mode and the brand's ground.
- **Bone** `#F2F0EA` / Paper `#FAF9F6`: warm off-white for documents, marketing and light UI. Not sterile white.
- **Phosphor** `#C8F54A`: the single brand accent, borrowed from oscilloscope traces. Used sparingly: the mark, primary CTAs, "live" signal, the healthy trace in charts. Never for text on bone (use phosphor-ink `#4A6500`).
- **Severity:** Sev1 `#E5484D` red, Sev2 `#EE6A1B` orange, Sev3 `#D19A16` amber, Sev4 `#4C7BE8` blue. Each has a tint.
- **Status:** Triggered (red), Acknowledged (amber), Mitigated (blue), Resolved (green `#2F9E62`).
- Severity and status colors are functional only. They never appear as decoration.

## Type
- Geist for display and text; Geist Mono for timestamps, service names, IDs, metrics and the eyebrow labels.
- Scale: 10 / 11 / 13 / 15 / 18 / 24 / 36 / 56 / 84. Display tracking -0.03em, line-height 1.0–1.1.
- Mono eyebrows: 11px, uppercase, +0.08em.

## Spacing and shape
- 4px base; 8/12/16/24/32/48/64/96 rhythm.
- Radii small and engineered: 3 / 6 / 10 / 16. Pills only for status chips.
- 1px hairlines carry structure (line `#E4E1D8` on bone, `#2A3039` on ink). Few shadows.

## The mark
A circle (the system) cut by a horizontal signal trace that spikes once and returns to flat: an incident, contained. Works at 16px as a favicon.

## Voice
- Say what happened, what's affected, what's next. In that order.
- Timestamps in UTC with the zone. Services in mono.
- No exclamation marks, no "oops", no blame. Postmortems are blameless by default.

## Fictional data used across the file
- Customer org: **Northwind Pay** (payments platform). Services: checkout-api, payments-worker, ledger-svc, auth-gateway, fraud-scorer, notifications-svc, search-api, cdn-edge.
- Live incident: **INC-2481** Sev1, "Elevated 5xx on checkout-api in us-east-1", started 14:02 UTC Tue 20 Oct 2026.
- People: Priya Raman (IC), Marcus Oyelaran (payments on-call), Lena Hoffmann (SRE), Tomás Ibarra (comms), Aiko Tanaka, Dev Kapoor, Sofia Brandt, Owen Mercer.
- Customer wordmarks (invented): Northwind Pay, Kestrel, Altamira, Corvid Health, Lumen Freight, Parallax, Orbis Bank, Tidewater.
