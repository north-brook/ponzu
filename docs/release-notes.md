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

Ponzu ships two apps that release apart: the desktop app (`vX.Y.Z`, built
for the Mac, Windows and Linux from the same tag, which all show the same
notes) and the iPhone app (`mobile-vX.Y.Z`, [mobile.md](mobile.md)). Release Please
leaves `apps/mobile`, `apps/api`, `apps/runner`, `packages/db`, `packages/sandbox`,
`packages/evals`, `infra` and `docs` out of the Mac's release (`exclude-paths` in
release-please-config.json), and a pull request that changes only those paths has no
notes in the Mac's release notes either. One of them that changes `apps/mobile` is the
iPhone's. A pull request that changes both apps says which app each note is about:

```md
## Release note

- Mac: Pair an iPhone from the Ponzu menu.
- iPhone: Find the Macs on your Wi-Fi without scanning a code.
```

The desktop app's release notes drop `iPhone:` notes and show `Mac:` notes
without the label, on Windows and Linux too. A note with neither label shows
on the desktop, and on the iPhone only when its pull request changed nothing
but `apps/mobile`. The iPhone's notes are its `iPhone:` notes, without the
label, and those unlabelled ones.

## How it travels

1. The squash merge copies the pull request's description into the commit
   message, so the note lands on `main` with the change.
2. Release Please tags the release (`vX.Y.Z`) as usual.
3. The desktop build runs `scripts/release-notes.ts`, which reads main's history
   and groups every commit's notes under the `vX.Y.Z` tag that shipped it,
   leaving out the iPhone's, into `dist/release-notes.json`. Commits after the
   newest tag are not in any release yet and are left out.
4. The release publishes the same file as `release-notes.json` beside its
   builds. An app that has downloaded the update shows the notes of every
   release since the one it runs in its title bar's update popover, before
   anyone installs it. A Mac offered an update only because another of the
   person's Macs already runs it has downloaded nothing, so its server reads
   the same file from that release instead. That popover is the only place
   they show: nothing repeats them after the restart.

A checkout without tags or history (a shallow clone) writes no notes and
warns, marking the file incomplete.

The site's [changelog](https://ponzu.design/changelog) shows the same notes.
The release's publish job also runs `scripts/release-notes.ts --changelog`,
which writes both apps' releases, each with the date of its tag's commit, and
publishes them beside the build as `changelog.json`. The site reads that file
from the latest release every hour and shows the releases of Ponzu Cloud, from
the first versions named in `apps/web/components/site.ts`, newest first. It
is published only with the desktop app, so an iPhone release shows there once
the next desktop release is out. A desktop version whose GitHub release is
still a draft was never published, so the page leaves it out and shows its
notes under the release after it, which is the one that brought them to
people (the publish job names those drafts with `--unpublished`). If the file
can't be read, the page says so and links to GitHub's releases.

The iPhone's notes travel the same way to TestFlight. When a `mobile-vX.Y.Z`
release builds a new binary, `apps/mobile/.eas/workflows/production.yml`
runs `bun scripts/release-notes.ts --phone mobile-vX.Y.Z`, which prints the
notes of the phone's commits since its tag before, and sends them as the
build's What to Test (up to Apple's 4,000 characters, dropping whole notes
past it). A release with no notes, or a run that can't read the history,
sends "Bug fixes and improvements." instead. A release that ships over the
air has no TestFlight build, so its notes go nowhere.

## Fixing a note

Notes come from commit messages on `main`, which are never rewritten, so a
shipped note can't be edited. Get it right in review. If a note went out wrong,
the next pull request's note can correct it ("Exports keep their fonts, as the
last update meant to say.").
