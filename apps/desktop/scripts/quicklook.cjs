// The Quick Look thumbnail extension that gives .design files their canvas
// preview as a Finder icon (quicklook/ThumbnailProvider.swift).
//
// electron-builder neither builds nor signs app extensions: it skips
// Contents/PlugIns when signing. So `afterPack` compiles the extension into
// the app and signs it ad hoc, and `sign` re-signs it with the release
// identity before electron-builder signs and seals the app around it.
//
// Testing it: Quick Look's ThumbnailsAgent remembers which extension handles
// a type until it restarts, so after registering a new build run
// `killall com.apple.quicklook.ThumbnailsAgent` (or log out and back in).
const { execFileSync } = require("node:child_process");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");

const NAME = "PonzuQuickLook";
const MIN_MACOS = "12.0";
const source = join(__dirname, "../quicklook");
const entitlements = join(source, "entitlements.plist");

const appexIn = (app) => join(app, "Contents/PlugIns", `${NAME}.appex`);

function infoPlist(appId, version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Ponzu Thumbnails</string>
  <key>CFBundleExecutable</key><string>${NAME}</string>
  <key>CFBundleIdentifier</key><string>${appId}.quicklook</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${NAME}</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>${MIN_MACOS}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionAttributes</key>
    <dict>
      <key>QLSupportedContentTypes</key><array><string>design.ponzu.design</string></array>
      <key>QLThumbnailMinimumDimension</key><integer>16</integer>
    </dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.quicklook.thumbnail</string>
    <key>NSExtensionPrincipalClass</key><string>${NAME}.ThumbnailProvider</string>
  </dict>
</dict>
</plist>
`;
}

function signAppex(appex, identity, keychain) {
  execFileSync("codesign", [
    "--sign",
    identity,
    "--force",
    "--options",
    "runtime",
    ...(identity === "-" ? [] : ["--timestamp"]),
    ...(keychain ? ["--keychain", keychain] : []),
    "--entitlements",
    entitlements,
    appex,
  ]);
}

/** Compiles the extension into Contents/PlugIns. macOS builds only. */
exports.afterPack = async (context) => {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") return;
  const { packager, appOutDir } = context;
  const app = join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const appex = appexIn(app);
  rmSync(appex, { recursive: true, force: true });
  mkdirSync(join(appex, "Contents/MacOS"), { recursive: true });
  writeFileSync(
    join(appex, "Contents/Info.plist"),
    infoPlist(packager.appInfo.id, packager.appInfo.version),
  );
  // The extension runs in its own process, so it must match the app's architecture.
  const archs = SWIFT_ARCHS[context.arch];
  if (!archs) throw new Error(`No Quick Look extension build for arch ${context.arch}`);
  const binary = join(appex, "Contents/MacOS", NAME);
  const slices = archs.map((arch) => {
    const out = archs.length > 1 ? `${binary}-${arch}` : binary;
    compile(arch, out);
    return out;
  });
  if (slices.length > 1) {
    execFileSync("lipo", ["-create", ...slices, "-output", binary]);
    for (const s of slices) rmSync(s);
  }
  // Unsigned extensions never load; an unsigned build still gets a working local one.
  signAppex(appex, "-");
};

/** electron-builder's Arch enum (builder-util) to Swift target architectures. */
const SWIFT_ARCHS = { 1: ["x86_64"], 3: ["arm64"], 4: ["arm64", "x86_64"] };

function compile(arch, out) {
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-O",
      "-module-name",
      NAME,
      "-parse-as-library",
      "-application-extension",
      "-target",
      `${arch}-apple-macos${MIN_MACOS}`,
      "-framework",
      "QuickLookThumbnailing",
      // App extensions start in Foundation's NSExtensionMain, not main().
      "-Xlinker",
      "-e",
      "-Xlinker",
      "_NSExtensionMain",
      join(source, "ThumbnailProvider.swift"),
      "-o",
      out,
    ],
    { stdio: "inherit" },
  );
}

/** mac.sign: the extension with the release identity, then the app as usual. */
exports.sign = async (opts) => {
  signAppex(appexIn(opts.app), opts.identity, opts.keychain);
  const builder = createRequire(require.resolve("electron-builder/package.json"));
  const { sign } = builder("app-builder-lib/out/codeSign/macCodeSign");
  return sign(opts);
};
