# Contributing

```sh
bun install
bun run dev          # the studio with hot reload, on the three examples/
bun run lint && bun run typecheck && bun test
```

The desktop app: `cd apps/desktop && bun run start`.

`serve` from a checkout listens on that checkout's own port in 7800–7999 (it
prints it) and stays off the tailnet, so it never takes 7777 or the iPhone's
Bonjour advert from the installed app. `--tailnet` opts back in.

## Pull requests

PRs are squash-merged, and **the PR title becomes the commit on `main`**, so it
must be a [Conventional Commit](https://www.conventionalcommits.org) with a
lowercase description. CI checks it.

| Title | Release |
|---|---|
| `fix: …` | patch |
| `feat: …` | minor |
| `feat!: …` or a `BREAKING CHANGE:` footer | major (minor while `0.x`) |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:`, `build:` | none on their own |

Scopes are optional: `fix(desktop): …`, `feat(react): …`.

### Release notes

A change users would notice ends its PR description with a `## Release note`
section: one plain sentence per change, written for someone who uses Ponzu.
The squash merge carries it into the commit, and the next release shows it in
the app's What's new after the update. No section means no note. See
[docs/release-notes.md](docs/release-notes.md).

## Releases

Nobody bumps versions or pushes tags by hand.
[Release Please](https://github.com/googleapis/release-please) keeps one open
release PR (`chore(main): release X.Y.Z`) that collects every `feat` and `fix`
on `main` into `CHANGELOG.md`, and the release workflow turns on auto-merge for
it. Once its checks pass it merges, and then
[`release.yml`](.github/workflows/release.yml):

1. Tags `vX.Y.Z` and opens a draft GitHub release with the changelog.
2. Builds the Mac app on a macOS runner, signs it with Northbrook's Developer ID,
   notarizes and staples it, and uploads the DMG, the update zip and
   `latest-mac.yml` into the draft.
3. Verifies the signature, the notarization ticket and Gatekeeper's verdict,
   then launches the exact signed app and waits for it to start its server and
   paint the studio (`PONZU_SMOKE=1`, see `apps/desktop/src/smoke.ts`).
4. Publishes the release. Only now can the site's download link and
   installed apps see it.

So a merged `fix:` or `feat:` reaches everyone without anyone touching the
release PR. To hold a release, close the release PR; the next push to `main`
reopens it. To rebuild an existing release after a build-only fix, run the
Release workflow by hand with its tag.

Installed apps check for a newer release at launch and every four hours,
download it in the background, and show Update in the title bar once it's
ready. One click installs it on every one of the person's Macs on their
tailnet, the clicked one last; a Mac that was off catches up once it's back
and nobody is using it. It also installs on quit (`apps/desktop/src/updater.ts`,
`packages/core/src/update.ts`). The DMG keeps one name across versions, so
<https://github.com/north-brook/ponzu/releases/latest/download/Ponzu-arm64.dmg>
always downloads the newest build.

Signing secrets live in the `release-signing` environment, which only `main`
can use: `APPLE_CERTIFICATE` (the Developer ID `.p12`, base64),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_BASE64` (an App Store Connect API
key), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. `RELEASE_TOKEN` is a
repository secret: a token that can open and merge pull requests, so the
release PR's checks run (pull requests opened with the workflow's own token
start no workflows).
