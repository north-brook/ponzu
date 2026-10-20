# Release notes

What people read about a change in Ponzu is written by the pull request that
made it, reviewed with it, and shipped with the release that carries it.
Nobody writes notes at release time.

## Writing one

A pull request whose change a user would notice ends its description with:

```md
## Release note

- Comments show who replied and when.
- Double-click a page tab to rename it.
```

- One plain sentence per thing a user can now do, or that now works. Present
  tense, sentence case, a full stop.
- For someone who uses Ponzu, not someone who builds it: no package, pipeline
  or test names, no PR numbers or links.
- A fix says what now works ("Pins stay on their node while you zoom."), not
  what was broken.
- Keep the section last before any sign-off; a line like "🤖 Generated with …"
  ends it, and so do git trailers such as `Co-Authored-By:`.
- Leave the section out when nobody would notice: CI, tests, docs, internal
  tooling, refactors. No section means no note.

CI warns on a `feat:` or `fix:` pull request without the section. It does not
block: some fixes are invisible.

## How it travels

1. The squash merge copies the pull request's description into the commit
   message, so the note lands on `main` with the change.
2. Release Please tags the release (`vX.Y.Z`) as usual.
3. The Mac build runs `scripts/release-notes.ts`, which reads main's history
   and groups every commit's notes under the tag that shipped it. The result,
   `dist/release-notes.json`, is bundled into the app. Commits after the newest
   tag are not in any release yet and are left out.
4. Launched into a newer version, the app shows **What's new** once, with the
   notes of every release since the one whose notes it last showed
   (`apps/desktop/src/whats-new.ts`). A first install shows nothing. Closing
   the dialog marks the notes seen; if the app quits before then, they show
   again next launch.

To preview it in development, start the app with
`PONZU_WHATS_NEW_SINCE=<an older version>`. A checkout without tags or history
(a shallow clone) bundles no notes and warns.

## Fixing a note

Notes come from commit messages on `main`, which are never rewritten, so a
shipped note can't be edited. Get it right in review. If a note went out wrong,
the next pull request's note can correct it ("Exports keep their fonts, as the
last update meant to say.").
