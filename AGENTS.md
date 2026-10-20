# Ponzu

See [README.md](README.md) for the layout and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

- Run `bun run lint`, `bun run typecheck`, `bunx tsc -p apps/desktop/tsconfig.json --noEmit` and `bun test` before finishing.
- **PR titles are Conventional Commits** with a lowercase description (`fix:`, `feat:`, `feat!:`); CI checks them. PRs are squash-merged, so the title is the commit Release Please reads.
- **Never edit version fields or push tags.** Release Please owns versions; its release PR merges itself and `.github/workflows/release.yml` signs, notarizes, verifies and publishes the Mac app.
- Packaging changes: `cd apps/desktop && bun run package:dir`, then `PONZU_SMOKE=1 out/mac-arm64/Ponzu.app/Contents/MacOS/Ponzu` must exit 0. Unset `ELECTRON_RUN_AS_NODE` first if your shell exports it.
