# iPhone end-to-end tests

[Maestro](https://maestro.dev) flows that drive a Release build of the app on
the iOS Simulator. One flow so far:

- `launch.yaml`: a fresh install opens on the launch screen, with the slice
  (labelled "Ponzu") and the wordmark.

Flows find views by `testID` (`id:` in Maestro) or by their text or
accessibility label. Give a screen a `testID` named after it (`launch`,
`designs`, `canvas`) so a flow can wait for it without depending on copy.

## Run them

Build a Release app for the simulator once, install it, then run the flows:

```sh
cd apps/mobile
bunx expo prebuild --platform ios --clean
xcodebuild -workspace ios/Ponzu.xcworkspace -scheme Ponzu -configuration Release \
  -sdk iphonesimulator -destination 'name=iPhone 17 Pro' -derivedDataPath ios/build \
  CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted ios/build/Build/Products/Release-iphonesimulator/Ponzu.app
maestro test maestro/
```

A Release build carries its JavaScript, so no Metro is needed. Flows that
reach a Mac need a Ponzu running on the tailnet; those come with the screens
that use them.

## Continuous integration

`Mobile iOS` in `.github/workflows/ci.yml` is meant to run these on the
self-hosted Macs (`[self-hosted, macOS, ARM64, spare-ios]`) for pull requests
from this repository that `scripts/ci/scope.ts` says can affect the phone.
Forks never run on them. Until the runners serve this repository and the
build and flow runner exist, the job only checks out the flows, and it runs
only when the repository variable `MOBILE_IOS` is `true`. The `Mobile` check
reports for every pull request either way.
