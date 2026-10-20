# Desktop build resources

- `icon.icns`, `icon-1024.png`: the app and `.design` document icon.
- `installer-icon.icns`, `installer-icon.png`: the mounted DMG's icon, the app
  icon with an install badge so the disk image isn't mistaken for the app.
  Regenerate with `bun run icons:installer` whenever the app icon changes.
- `entitlements.mac.plist`: the hardened-runtime exceptions the signed app and
  its bundled server need. Electron's V8 and the server (a `bun build --compile`
  binary) both JIT, and Bun documents this set for signed standalone
  executables. codesign rejects comments inside the plist, so they live here.
- `background.png`, `background@2x.png`: the disk image window's background, a
  faint warm ground with an arrow from the app to Applications and one line on
  what to do. electron-builder picks them up by name and joins the pair. The
  icon positions in `dmg.contents` (package.json) must match the centres in
  `scripts/make-dmg-background.swift`; regenerate with
  `swift scripts/make-dmg-background.swift` after changing either.
