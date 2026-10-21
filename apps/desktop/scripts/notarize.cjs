// Notarizes the signed app and staples its ticket, before electron-builder
// packs the app into the DMG and zip.
//
// This replaces electron-builder's own notarization (mac.notarize is false),
// which staples once: @electron/notarize wraps stapling in promise-retry but
// never calls its retry callback, so when Apple's ticket service drops the
// connection (stapler exit 68, NSURLErrorDomain -1005) a release fails after
// notarization already succeeded. Here stapling retries with backoff.
//
// Builds without the App Store Connect API key (APPLE_API_KEY, APPLE_API_KEY_ID,
// APPLE_API_ISSUER) are signed but not notarized, as electron-builder did.
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");

const STAPLE_ATTEMPTS = 6;
/** Waits 15s, 30s, 45s… between attempts: under four minutes in all. */
const STAPLE_BACKOFF_MS = 15_000;

const builder = createRequire(require.resolve("electron-builder/package.json"));
const { log } = builder("builder-util");

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.afterSign = async (context) => {
  if (context.electronPlatformName !== "darwin") return;
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  if (!key && !keyId && !issuer) {
    log.info({ reason: "no App Store Connect API key" }, "skipped macOS notarization");
    return;
  }
  if (!key || !keyId || !issuer) {
    throw new Error("Set all of APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER to notarize");
  }
  const auth = ["--key", key, "--key-id", keyId, "--issuer", issuer];
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const cwd = dirname(app);

  // notarytool takes a zip of the app, not the bundle itself.
  const dir = mkdtempSync(join(tmpdir(), "ponzu-notarize-"));
  try {
    const zip = join(dir, `${basename(app, ".app")}.zip`);
    const ditto = ["-c", "-k", "--sequesterRsrc", "--keepParent", basename(app), zip];
    const zipped = run("ditto", ditto, { cwd });
    if (zipped.code !== 0) {
      throw new Error(`Failed to zip the app for notarization\n\n${zipped.output}`);
    }
    log.info({ file: log.filePath(app) }, "notarizing");
    const submit = run("xcrun", [
      "notarytool",
      "submit",
      zip,
      ...auth,
      "--wait",
      "--output-format",
      "json",
    ]);
    let result;
    try {
      result = JSON.parse(submit.stdout);
    } catch {
      throw new Error(`notarytool gave an unexpected result\n\n${submit.output}`);
    }
    if (submit.code !== 0 || result.status !== "Accepted") {
      const details = result.id
        ? run("xcrun", ["notarytool", "log", result.id, ...auth]).output
        : "";
      throw new Error(`Notarization failed\n\n${submit.output}\n\n${details}`);
    }
    log.info({ id: result.id }, "notarization successful");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (let attempt = 1; ; attempt++) {
    const staple = run("xcrun", ["stapler", "staple", "-v", basename(app)], { cwd });
    if (staple.code === 0) break;
    if (attempt === STAPLE_ATTEMPTS) {
      throw new Error(
        `Stapling failed ${attempt} times, last with code ${staple.code}\n\n${staple.output}`,
      );
    }
    const wait = STAPLE_BACKOFF_MS * attempt;
    log.warn({ code: staple.code, attempt, retryInSeconds: wait / 1000 }, "stapling failed");
    await sleep(wait);
  }
  log.info({ file: log.filePath(app) }, "stapled the notarization ticket");
};
