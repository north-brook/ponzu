---
name: ponzu-design-brief
description: Start a new design in Ponzu from a brief. Sets up the .design file, tokens and first artboards. Use when asked to design a page, screen, flow or brand from scratch.
---

# From brief to first artboards

1. Restate the brief in a few lines and write it to `notes/brief.md` (`write_note`). Include audience, tone, must-haves, and what's out of scope.
2. Pick a direction before building: palette (5–8 colors), two type families, a type scale, spacing and radius. Name them as tokens and set them in one `create_file` (new file) or `set_tokens` (existing).
3. `get_guide('basics')` and `get_guide('layout')` if you haven't this session.
4. Build the key screen first, in small pieces: frame (`create_artboard`), then each section with `write_html`. Screenshot after every two or three writes and fix lint.
5. Offer 2–3 variations of the key screen side by side (`duplicate`, then change one idea each). Name them for the idea ("Hero / editorial", "Hero / product-first").
6. Beside the variations, `create_artboard` a "Note: …" (height `fit-content`) explaining each one, then ask the person to pick in your reply.

Don't build every screen before the direction is agreed.
