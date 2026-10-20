# Desktop build resources

- `icon.icns`, `icon-1024.png`: the app and `.design` document icon.
- `entitlements.mac.plist`: the hardened-runtime exceptions the signed app and
  its bundled server need. Electron's V8 and the server (a `bun build --compile`
  binary) both JIT, and Bun documents this set for signed standalone
  executables. codesign rejects comments inside the plist, so they live here.
