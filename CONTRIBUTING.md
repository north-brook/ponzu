# Contributing

```sh
bun install
bun run dev          # the studio with hot reload, on the three examples/
bun run lint && bun run typecheck && bun test
```

The desktop app: `cd apps/desktop && bun run start`. The iPhone app:
`cd apps/mobile && bunx expo run:ios`, see [docs/mobile.md](docs/mobile.md).

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
the app's update popover. No section means no note. In a PR that
changes both the Mac and the iPhone app, start each note with `Mac:` or
`iPhone:`. See [docs/release-notes.md](docs/release-notes.md).

## Releases

Nobody bumps versions or pushes tags by hand.
[Release Please](https://github.com/googleapis/release-please) releases two
components, each with its own release PR:

- **The Mac app and CLI** (the root package, tags `vX.Y.Z`): `chore(main):
  release X.Y.Z` collects every `feat` and `fix` on `main` into `CHANGELOG.md`.
  Changes only under `apps/mobile` don't count.
- **The iPhone app** (`apps/mobile`, tags `mobile-vX.Y.Z`): `chore(main):
  release mobile X.Y.Z` collects those that touch `apps/mobile` into
  `apps/mobile/CHANGELOG.md`. Its tag starts EAS's production workflow, which
  ships over the air or builds for TestFlight; see
  [docs/mobile.md](docs/mobile.md#releases).

The release workflow turns on auto-merge for both. Once a release PR's checks
pass it merges, and for the Mac app
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

Beside the Mac build, the same version of the CLI goes to npm as `ponzu`, which
`bunx ponzu` runs: bundled for Bun with the studio
(`scripts/npm-package.ts`), installed from its tarball and checked to serve
the studio (`scripts/npm-smoke.ts`, which CI's desktop job also runs), then
published with provenance. A version npm already has is skipped.

So a merged `fix:` or `feat:` reaches everyone without anyone touching the
release PR. To hold a release, close its release PR; the next push to `main`
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

npm takes the `ponzu` package from the release workflow by [trusted
publishing](https://docs.npmjs.com/trusted-publishers): on npmjs.com, the
package's settings name `north-brook/ponzu` and `release.yml` as its
publisher, so no token is stored. For the first publish, sign in interactively
with `npm login`, build the studio and npm package, run its smoke test, then
run `npm publish ./apps/cli/npm --access public` and complete the 2FA prompt.
Once the package exists, configure its trusted publisher before the next
release. Future releases publish from GitHub Actions with provenance; no
`NPM_TOKEN` repository secret is needed.
