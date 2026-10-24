// The native fingerprint decides whether a release ships over the air or as
// a new TestFlight build. Release Please bumps app.json's version on every
// release, and the default fingerprint includes it, so every release would
// rebuild the native app. Leaving it out lets a JavaScript-only release ship
// over the air, carrying its version in the update's manifest.
/** @type {import('expo/fingerprint').Config} */
module.exports = { sourceSkips: ["ExpoConfigVersions"] };
