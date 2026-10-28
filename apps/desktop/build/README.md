# Desktop build resources

- `icon.icns`, `icon-1024.png`: the app and `.design` document icon.
- `icon.ico`, `icons/<size>x<size>.png`: the Windows and Linux app icons, the
  Mac icon's tile cropped out of its margin and shadow. Regenerate with
  `bun run icons:platforms` whenever the app icon changes.
- `tray.png`, `tray@2x.png`: the Windows and Linux tray icon.
- `installer.nsh`, `uninstall.ps1`: the Windows installer's uninstall step,
  which removes what the app registers for the person at launch (the
  design.json association, `~\.ponzu\bin` on their PATH). Not on an update.
- `deb-after-remove.sh`: the `.deb`'s postrm, electron-builder's own plus,
  when the package is removed rather than upgraded, the wake helper's systemd
  user units that ran it. electron-builder fills in its `${name}` macros, so
  the shell's own variables there go without braces.
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
