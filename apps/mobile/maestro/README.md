# iPhone end-to-end tests

[Maestro](https://maestro.dev) flows that drive a Debug development client
on the iOS Simulator, against this checkout's JavaScript (from Metro) and a
Ponzu serving the three examples. They run in this order (`config.yaml`):

| Flow | What it checks |
| --- | --- |
| `launch.yaml` | A clean install with every Mac forgotten: the slice and wordmark on yuzu, then the code on your Mac (by way of Tailscale, when this Mac's is off). |
| `designs.yaml` | Designs lists Kettle, Halon and Weft, under the tab bar (Designs, Activity, Search); the header's filter menu picks Archived, then Recent again. |
| `canvas.yaml` | Kettle opens on its canvas, with no tab bar over it: the bar, its boards drawn in the web view, and the page button's menu turning it to Website. |
| `open-link.yaml` | An agent's `ponzu://open?file=…` link (and iOS's `ponzu:///open?…`) opens Kettle on its canvas. |
| `search.yaml` | The search tab's system field: "brand" shows Files and Frames. |
| `activity.yaml` | The Activity tab: one list, its filter (New by default, Show everything), and `ponzu://activity?since=1` shows "Claude added 3 artboards" with thumbnails, which opens that design. |
| `comment.yaml` | A comment on Kettle's Logo (the `?comment=` link), its pin and thread sheet, Resolve, then `?uncomment=` deletes it. |
| `comment-modes.yaml` | The comment sheet switches typing → voice → typing (the field, then "Listening…", the mute and the keyboard button, then the field again) and sends. |

`shared/start.yaml` opens the client onto Metro, closes the development
menu if it shows, and waits for Designs. It refuses the microphone and
speech recognition, so a comment sheet in voice offers typing with no system
prompt in the way. Every flow checks no development warning
("Cannot update a component…") is on screen.

Flows find views by `testID` (`id:` in Maestro) or by text: `launch`,
`designs`, `card-<name>`, `tab-designs`, `tab-activity`, `tab-search`, `search`,
`search-files`, `search-frames`, `canvas`, `title`, `page-menu`, `chrome`, `chrome-hidden`, `hint`,
`comment-sheet`, `comment-input`, `to-type`, `to-voice`, `mute`, `transcript`, `send`, `thread-sheet`,
`resolve`, `activity`, `activity-empty-<caughtUp|never|noKind>`, `activity-show-everything`, `activity-show-all-kinds`, `activity-where`, `tailscale`, `tailscale-continue`, `connect`. Give a new screen a `testID` named after it.
Wait with `extendedWaitUntil`, never a fixed sleep.

Before the flows, `run.sh` has an agent make a change for Activity:
`agent.ts` connects to the server's MCP as `claude-code`, creates a design in
a temporary folder and adds three artboards. The server keeps its catalog
database and history in that folder too (`PONZU_HOME`), never this Mac's.
Already running a server, run it yourself first:
`bun apps/mobile/maestro/agent.ts <port> $(mktemp -d)`.

The comment flow leaves `examples/` as it was: it deletes its comment with
the development link `ponzu://design/dev/<key>?uncomment=Maestro` (every
thread of yours starting with that text), and Ponzu removes `comments.json`
when its last thread goes. `run.sh` fails if `examples/` changed.

## Run them

Java 17 or later and the Maestro CLI:

```sh
brew install openjdk@17
curl -fsSL "https://get.maestro.mobile.dev" | bash   # into ~/.maestro
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 PATH="$JAVA_HOME/bin:$HOME/.maestro/bin:$PATH"
```

Then, from the repository root, with a booted simulator's UDID:

```sh
apps/mobile/maestro/run.sh <udid>
```

It starts a Ponzu on the examples and Metro on free ports, builds the
development client (`expo prebuild`, `xcodebuild` Debug), installs it, and
runs every flow. Already running both, with the client installed:

```sh
PONZU_PORT=7794 METRO_PORT=8095 SKIP_BUILD=1 apps/mobile/maestro/run.sh <udid>
```

Metro must have been started with `EXPO_PUBLIC_PONZU_DEV_HOST` pointing at
that Ponzu (`apps/mobile/.env.local`, see [docs/mobile.md](../../../docs/mobile.md)),
which development builds pair as "This Mac". One flow on its own:

```sh
maestro --device <udid> test -e KETTLE=<encoded kettle.design path> \
  -e DEV_CLIENT='exp+ponzu://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8095' \
  apps/mobile/maestro/search.yaml
```

When a flow fails, `~/.maestro/tests/<run>/` holds each step's result and
the view hierarchy it saw (`commands.json`) and a screenshot of the failure.

## Continuous integration

`Mobile iOS` in `.github/workflows/ci.yml` runs `run.sh` on the self-hosted
Macs (`[self-hosted, macOS, ARM64, spare-ios]`) for pull requests from this
repository that `scripts/ci/scope.ts` says can affect the phone, on the
simulator the runner assigns (`IOS_SIMULATOR_UDID`). The runners carry Xcode,
Java and Maestro. Forks never run on them. The job runs only when the
repository variable `MOBILE_IOS` is `true`, set once those runners serve
this repository. It uploads the JUnit report and Maestro's debug output. The
`Mobile` check reports for every pull request either way.
