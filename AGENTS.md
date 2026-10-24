# Ponzu

See [README.md](README.md) for the layout and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

- Run `bun run lint`, `bun run typecheck`, `bunx tsc -p apps/desktop/tsconfig.json --noEmit` and `bun test` before finishing.
- **A change users would notice ends its PR description with a `## Release note` section**: one plain sentence per change. The squash commit carries it into the desktop app's What's new; no section means no note. In a PR that changes both apps, prefix each note `Mac:` or `iPhone:`. See [docs/release-notes.md](docs/release-notes.md).
- **PR titles are Conventional Commits** with a lowercase description (`fix:`, `feat:`, `feat!:`); CI checks them. PRs are squash-merged, so the title is the commit Release Please reads.
- **Never edit version fields or push tags.** Release Please owns versions, for two components: the Mac app and CLI (`vX.Y.Z`) and the iPhone app in `apps/mobile` (`mobile-vX.Y.Z`). Each release PR merges itself; `.github/workflows/release.yml` signs, notarizes, verifies and publishes the Mac app, and EAS ships the phone (over the air, or a TestFlight build when native code changed).
- **The iPhone app** (`apps/mobile`, Expo): see [docs/mobile.md](docs/mobile.md). Never import `@ponzu/react`, `@ponzu/render` or `@ponzu/server` from it. `ios/` is generated; don't commit it. Native iOS builds and simulator runs follow `docs/mobile.md`.
- Packaging changes: `cd apps/desktop && bun run package:dir`, then `PONZU_SMOKE=1 out/mac-arm64/Ponzu.app/Contents/MacOS/Ponzu` must exit 0. Unset `ELECTRON_RUN_AS_NODE` first if your shell exports it.
