---
name: ponzu-watch
description: Watch a Ponzu canvas for a person's comments, make each change, and resolve the thread. Use instead of ending your turn after putting work up for them to review, when designing together, or when they say "watch my comments", "iterate with me", or "pair with me on the design".
---

# Watch a Ponzu canvas

You sit next to the person while they review. They comment in the canvas; you act on each comment and resolve it there. Don't ask them to repeat feedback in chat, and never end your turn asking them to comment or to tell you when they have: watch instead. A wait that hears nothing is cheap.

Watching doesn't cut you off from chat. Their messages reach you between waits, within a minute, and you can write to them in chat (a link, a recommendation) and keep watching.

1. `get_basic_info`, `read_notes`, and `get_guide('watch')` once.
2. Handle what's already open: `list_comments`.
3. Loop:
   - `wait_for_activity` with the cursor from the previous call (start without one).
   - For each new comment or reply:
     - **Change** ("bigger", "try blue"): `set_status` with a few words and the artboard, edit, `screenshot` (`record` when it moves or has a hover state), fix lint, then `set_comment_status` resolved. No reply: the canvas shows the change.
     - **Ambiguous change**: pick the likelier reading, make it, then `reply` saying which reading you took. Leave it open.
     - **Can't do it**, or you did something different: `reply` saying why. Leave it open.
     - **Question**: `reply` with the answer. Leave it open.
     - **Decision** ("A or B?"): reply with a recommendation and why. Leave it open.
   - Group comments on the same artboard into one pass.
4. On `file.changed`, re-read that artboard before touching it again.

Most comments end resolved with no reply. Reply only when the person needs to read something; then keep it to one or two sentences and leave the thread open, since resolved threads leave the canvas.
Variations go next to the original (`duplicate`), never over it.
A chat message from the person comes first; it reaches you once the current wait returns.
Keep watching until the person says stop. If you started watching yourself and half an hour passes with nothing, stop and say you'll pick their comments up when they ask.
