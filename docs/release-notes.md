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

### The Mac and the iPhone

Ponzu ships two apps that release apart: the Mac app (`vX.Y.Z`) and the
iPhone app (`mobile-vX.Y.Z`, [mobile.md](mobile.md)). A pull request that
changes only `apps/mobile` is the iPhone's: its notes never reach the Mac's
release notes, and Release Please leaves it out of the Mac's release. A pull
request that changes both says which app each note is about:

```md
## Release note

- Mac: Pair an iPhone from the Ponzu menu.
- iPhone: Find the Macs on your Wi-Fi without scanning a code.
```

The Mac's release notes drop `iPhone:` notes and shows `Mac:` notes without the
label. A note with neither label shows on the Mac.

## How it travels

1. The squash merge copies the pull request's description into the commit
   message, so the note lands on `main` with the change.
2. Release Please tags the release (`vX.Y.Z`) as usual.
3. The Mac build runs `scripts/release-notes.ts`, which reads main's history
   and groups every commit's notes under the `vX.Y.Z` tag that shipped it,
   leaving out the iPhone's, into `dist/release-notes.json`. Commits after the
   newest tag are not in any release yet and are left out.
4. The release publishes the same file as `release-notes.json` beside its
   build. An app that has downloaded the update shows the notes of every
   release since the one it runs in its title bar's update popover, before
   anyone installs it. That popover is the only place they show: nothing
   repeats them after the restart.

A checkout without tags or history (a shallow clone) writes no notes and
warns, marking the file incomplete.

## Fixing a note

Notes come from commit messages on `main`, which are never rewritten, so a
shipped note can't be edited. Get it right in review. If a note went out wrong,
the next pull request's note can correct it ("Exports keep their fonts, as the
last update meant to say.").
