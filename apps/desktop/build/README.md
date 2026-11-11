# Desktop build resources

- `icon.icns`, `icon-1024.png`: the app icon.
- `icon.ico`, `icons/<size>x<size>.png`: the Windows and Linux app icons, the
  Mac icon's tile cropped out of its margin and shadow. Regenerate with
  `bun run icons:platforms` whenever the app icon changes.
- `installer.nsh`, `uninstall.ps1`: the Windows installer's uninstall step,
  which removes what Ponzu 1.x registered for the person at launch (the
  design.json association, `~\.ponzu\bin` on their PATH). Not on an update.
  The cloud app registers neither; this stays for people who had 1.x.
- `installer-icon.icns`, `installer-icon.png`: the mounted DMG's icon, the app
  icon with an install badge so the disk image isn't mistaken for the app.
  Regenerate with `bun run icons:installer` whenever the app icon changes.
- `entitlements.mac.plist`: the hardened-runtime exceptions the signed app
  needs, and no more. Electron's V8 compiles JavaScript at run time, so it
  keeps `allow-jit` and `allow-unsigned-executable-memory`, the pair
  electron-builder's own template ships. 1.x also had
  `disable-executable-page-protection` and `disable-library-validation`, which
  Bun documents for a signed `bun build --compile` binary: they were for the
  local server the app bundled, which is gone. A hardened-runtime mistake only
  shows in a signed, notarized build, so the release workflow's smoke launch
  of the signed app is what proves this set. codesign rejects comments inside
  the plist, so they live here.
- `background.png`, `background@2x.png`: the disk image window's background, a
  faint warm ground with an arrow from the app to Applications and one line on
  what to do. electron-builder picks them up by name and joins the pair. The
  icon positions in `dmg.contents` (package.json) must match the centres in
  `scripts/make-dmg-background.swift`; regenerate with
  `swift scripts/make-dmg-background.swift` after changing either.
