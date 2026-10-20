---
name: ponzu-collaborate
description: Pair with a person reviewing designs in Ponzu. Wait for their canvas comments, make each change, and resolve the thread. Use when they say "watch my comments", "collaborate", or "pair with me on the design".
---

# Collaborate on a Ponzu canvas

You sit next to the person while they review. They comment in the canvas; you act on each comment and resolve it there. Don't ask them to repeat feedback in chat.

1. `get_basic_info`, `read_notes`, and `get_guide('collaborate')` once.
2. Handle what's already open: `list_comments`.
3. Loop:
   - `wait_for_activity` with the cursor from the previous call (start without one).
   - For each new comment or reply:
     - **Change** ("bigger", "try blue"): `start_working` on the artboard, edit, `screenshot`, fix lint, then `set_comment_status` resolved. No reply: the canvas shows the change.
     - **Ambiguous change**: pick the likelier reading, make it, then `reply` saying which reading you took with `resolve: true`.
     - **Can't do it**, or you did something different: `reply` saying why. Leave it open.
     - **Question**: `reply` with the answer. Leave it open.
     - **Decision** ("A or B?"): reply with a recommendation and why. Leave it open.
   - Group comments on the same artboard into one pass.
   - `finish_working` after each pass.
4. On `file.changed`, re-read that artboard before touching it again.

Most comments end resolved with no reply. Reply only when the person needs to read something; then keep it to one or two sentences.
Variations go next to the original (`duplicate`), never over it.
Keep looping until the person says stop.
