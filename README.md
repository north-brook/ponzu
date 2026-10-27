<p align="center"><img src="apps/web/public/favicon.svg" width="72" height="72" alt=""></p>

<h1 align="center">Ponzu</h1>

<p align="center">The design canvas for your coding agent.<br>Open source. Runs on your machine. Your agent designs in plain HTML and CSS, and you steer with comments.</p>

<p align="center"><a href="https://ponzu.design">ponzu.design</a> · <a href="#connect-an-agent">Connect an agent</a> · <a href="#the-design-format">The .design format</a> · <a href="#embed-it">Embed it</a></p>

<p align="center"><a href="https://ponzu.design/gh/north-brook/ponzu/design/brand.design"><img src="https://ponzu.design/badge.svg?label=brand" alt="brand | Ponzu"></a> <a href="https://ponzu.design/gh/north-brook/ponzu/design/press-kit.design"><img src="https://ponzu.design/badge.svg?label=press%20kit" alt="press kit | Ponzu"></a> <a href="https://ponzu.design/gh/north-brook/ponzu/design/components.design"><img src="https://ponzu.design/badge.svg?label=design%20system" alt="design system | Ponzu"></a></p>

---

Ponzu is an infinite canvas of artboards. Agents draw on it over MCP, writing HTML and CSS, and you watch it happen live. You leave comments on the canvas; the agent picks them up, makes the change, and resolves them. There are no manual editing panels. If you want something changed, you ask.

- **Free forever.** MIT. No account, no seats, no limits. Bring the agent you already use.
- **Your files, your workflow.** A `.design` is a folder of HTML files on your disk. Commit it next to your code, sync it through Dropbox, or toss it.
- **Just HTML and CSS.** If a browser can do it, so can your design: grid, gradients, variable fonts, video, real animation. Agents watch their animations and hover states frame by frame, not just the first frame.

## Quick start

```sh
bunx ponzu serve
```

This opens the canvas in your browser and serves MCP at `http://127.0.0.1:7777/mcp`. Every `.design` folder under the current directory is opened. It needs [Bun](https://bun.sh); `bun add -g ponzu` keeps a `ponzu` command around.

To change a design someone committed to GitHub, open it by its path:

```sh
bunx ponzu open north-brook/ponzu/examples/kettle.design
```

This clones the repo into `~/Ponzu/north-brook/ponzu` (or reuses the clone there) and serves that design. It takes the same path as the [web viewer](#share-it-from-github), with `@branch` after the repo, or a `ponzu.design/gh` or `github.com` link.

Or [download the Mac app](https://ponzu.design/download) (Apple silicon, signed and notarized; it updates itself). It opens `.design` folders like documents, and on first launch it sets up Claude Code, Codex and Cursor for you. There's nothing else to install or keep running.

The app also puts `ponzu` in your terminal, running from inside the app so it updates with it. It links the command into a folder your shell already searches that you can write to (`~/.local/bin`, `~/bin` or `/usr/local/bin`), never over another `ponzu`. If there's no such folder, choose **Ponzu › Install Terminal Command…**, which asks for your password to add it to `/usr/local/bin`.

## Connect an agent

The Mac app does this on launch. Without it:

```sh
ponzu install          # every agent found: Claude Code, Codex, Cursor
ponzu install claude   # or just one
```

Agents get a command to launch, `ponzu mcp`, rather than a URL. It finds the running Ponzu (the app or `ponzu serve`) on whatever port it's on, so the agent shares your canvas. If the app is installed but not running, it starts it in the background, with no window until you open Ponzu. With neither, it runs the tools itself on the `.design` folders under the agent's project. With the app installed, the command runs from inside the app, so it updates with it.

Any other MCP client can launch `ponzu mcp` over stdio, or use `http://127.0.0.1:7777/mcp` while Ponzu runs. `ponzu install claude --url <url>` registers a URL, e.g. a Ponzu on another machine.

### The plugin

Claude Code and Codex can also install Ponzu as a plugin. It adds Ponzu's skills (start a design from a brief, bring a screen into Ponzu, explore variations, implement a design, watch your comments) and the same server the app sets up. It launches the Mac app's server, so open the app once first.

```sh
claude plugin marketplace add north-brook/ponzu && claude plugin install ponzu@ponzu
codex plugin marketplace add north-brook/ponzu && codex plugin add ponzu@ponzu
```

With the app's own setup there too, each agent keeps one Ponzu server, not two. The plugin lives in [`plugin/`](plugin).

Then ask for something:

> Design a landing page for a houseplant shop in a new `design/shop.design`. Give me three takes on the hero.

When an agent points you at a design, it gives you a link rather than a folder path, so it opens in Ponzu instead of your editor: `https://ponzu.design/local#mac=workstation&file=/path/to/app.design&artboard=ab_hero` for the Mac app, or the canvas's own `http://localhost:7777/?file=…` under `ponzu serve`. `artboard` is optional and opens on that board. `mac` is the Mac the design is on, by its Tailscale name, so the link opens on your other Macs too, through Ponzu's link between them; without Tailscale it's left out and the link opens the path on the Mac you click it on. The ponzu.design page hands the design to the app as `ponzu://open?mac=…&file=…` (chats drop links in schemes they don't know) or offers the download if Ponzu isn't installed; the path stays after the `#`, which browsers never send to the site. `/local` sits beside `/gh` for designs on GitHub.

To go back and forth on a design, use the `watch` prompt (or say "watch my comments in Ponzu"). The agent watches the canvas for your comments, handles each one and resolves it, replying only to answer a question or flag something. Agents also start watching on their own once they've put work up for you to review, and you can still chat with them while they do.

### Reach it from another machine

```sh
ponzu serve --host 0.0.0.0     # or your tailnet IP
ponzu install claude --url http://<that machine>:7777/mcp
```

Ponzu has no auth. Bind beyond localhost only on networks you trust, such as a tailnet.

## The design format

A `.design` is a folder. macOS shows it as a single document; everything else sees a directory.

```
weft.design/
  design.json          { "ponzu": 1, "name": "Weft", "pages": [{ "id", "name", "icon" }] }
  tokens.css           :root { --color-signal: #FF5A1F; … }
  comments.json        { "threads": [{ "id", "artboardId", "nodeId", "x", "y", "status", "messages", … }] }
  notes/brief.md       notes the agent keeps between sessions
  assets/              images and fonts
  pages/
    website/
      landing.html     one artboard per file
```

Each artboard file holds one `<section data-artboard>`. Its size is the `width` and `height` in its style (1440×900 without them); `data-x` and `data-y` only place it on the page.

```html
<section data-artboard data-id="ab_dr6yq" data-name="Landing" data-x="0" data-y="0" style="width:1440px;height:7216px;background-color:var(--color-paper)">
  <h1 data-id="n_g9oar7w" style="font:700 80px/0.95 var(--font-display);letter-spacing:-0.05em">Write locally. Sync everywhere.</h1>
</section>
```

- **Edit it however you like.** Ponzu watches the folder. An edit from your editor, `sed` or another agent shows up live and becomes an event agents can react to.
- **Ids are lazy.** Hand-written elements get stable ids derived from their position. Ponzu writes an id into a file only when something needs to point at it.
- **Inert by default.** `<script>`, `on*` handlers and `javascript:` URLs are stripped on load.
- **Comments are pins.** A thread in `comments.json` sits on an artboard (`artboardId`, plus `nodeId` for a node in it) or on a page's open canvas (`pageId`), at `x`/`y`. One missing a field isn't shown, and stays in the file until it's fixed.
- **Agents can read the format too.** `get_guide('format')` gives them every file's fields, with examples, for importing or generating a design by writing it directly.
- **Fonts just work.** Google Fonts named in `font-family` load automatically on the canvas and in screenshots.
- **Examples stay off your home screen.** `"example": true` in `design.json` marks a sample design. The home screen lists an example only once you open it yourself (from Finder, the app, or `ponzu serve path/to/example.design`), not when it's merely found: by Spotlight, by a scan of your folders, or because an agent started in a folder that has one. Agents still open and use examples like any other design. The ones in [`examples/`](examples) are marked.

To implement a design, point your coding agent at the folder. The HTML, tokens and comments are the spec.

### Share it from GitHub

A `.design` committed to a public repo opens on the canvas at `ponzu.design/gh/<owner>/<repo>/<path/to/name.design>`, read-only, with its comments, images and fonts: [this repo's Kettle](https://ponzu.design/gh/north-brook/ponzu/examples/kettle.design), for one. Add `@<branch, tag or commit>` to the repo for another ref, or leave off the path to list every design in the repo. Link it from your README with a badge labelled by the design's name; without `?label=` it reads "open in | Ponzu":

```md
[![Kettle | Ponzu](https://ponzu.design/badge.svg?label=Kettle)](https://ponzu.design/gh/<owner>/<repo>/<path/to/name.design>)
```

Ponzu keeps a light and a dark preview of each design in its `.ponzu/` folder (the picture Finder shows). Commit them, and a shared link's card shows the design itself.

## Embed it

Ponzu is a set of packages you can build into your own product:

| Package | What it does |
| --- | --- |
| `@ponzu/core` | HTML ↔ node tree, ops with inverses (undo, change feed), sanitizer |
| `@ponzu/store` | Opens a `.design` from any storage; diffs outside edits into ops |
| `@ponzu/tools` | The agent tools as transport-agnostic `{ name, schema, handler }` |
| `@ponzu/mcp` | Those tools over MCP (stdio and streamable HTTP) |
| `@ponzu/render` | Screenshots, frame-by-frame animation recordings, motion loops and a lint pass. Uses Chromium, an Electron window, or your own renderer |
| `@ponzu/react` | `<Canvas>`. Renders artboards with the host page's own engine, in shadow roots |
| `@ponzu/server` | The local host behind `ponzu serve` |

On a big page the canvas draws each board as cheaply as it can be seen: boards drawn small show as pictures (their looping motion as short videos over them), images load as copies sized to how they're drawn, and boards off screen skip rendering. A source that serves pictures provides `snapshotUrl` (and `loopsUrl`); without it every board is live DOM. `ponzu serve` makes pictures, loops and image copies in the background and keeps them in `~/.ponzu/cache` (`PONZU_HOME` moves it), trimmed to a few GB, least recently used first.

```tsx
import { Canvas, MemorySource } from "@ponzu/react";
import "@ponzu/react/styles.css";

<Canvas source={new MemorySource(doc, (next) => save(next))} theme="light" />
```

Use the tools without MCP, for example with the AI SDK or the Anthropic API:

```ts
import { tools, runTool, jsonSchema } from "@ponzu/tools";

const defs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t) }));
const result = await runTool(tools.find((t) => t.name === "write_html")!, args, { ws, caller });
```

## The agent surface

About thirty tools in six groups. `get_guide` serves the house rules.

| Group | Tools |
| --- | --- |
| Orient | `get_basic_info` `get_tree` `get_node` `get_html` `find_nodes` |
| Write | `create_artboard` `write_html` `update_styles` `set_text` `set_attributes` `duplicate` `move_nodes` `delete` `rename` `update_artboard` |
| See | `screenshot` (with lint) `record` `export` |
| Organize | `list_files` `create_file` `update_file` `create_page` `update_page` `archive` `get_tokens` `set_tokens` |
| Converse | `list_comments` `get_comment` `create_comment` `reply` `set_comment_status` `send_feedback` |
| Listen + remember | `wait_for_activity` `set_status` `write_note` `read_notes` `get_guide` |

Skills for agents that support them ship in [the plugin](#the-plugin), in [`plugin/skills/`](plugin/skills).

## Telemetry

The Mac app and the `ponzu` package send pseudonymous usage to the Ponzu team: which tools agents call and whether they fail (with a coarse reason, like a timeout), which agents connect, how often the canvas opens, and the Ponzu version and OS. Each install is a random id in `~/.ponzu/telemetry.json`. When Tailscale is running, Ponzu also links that id to a hash of your Tailscale user id, which is the same on each of your Macs, so the team counts people rather than machines. Your Tailscale id, name and email are never sent, but someone with the hash could check guessed ids against it. Nothing about your designs leaves your machine: no HTML, file names, paths, comment text or tool arguments.

Agents can also tell us how Ponzu is working for them with `send_feedback`. That's the one event with words in it, and it's about Ponzu, not your work.

Turn all of it off with `ponzu telemetry off`, or set `PONZU_TELEMETRY=0` or `DO_NOT_TRACK=1`. Nothing is sent in CI. Only release builds report: Ponzu built from source, or a fork, has no key and sends nothing. The packages you embed (`@ponzu/tools`, `@ponzu/react` and the rest) send nothing on their own; a host opts in by passing a `telemetry` to its workspace.

## Develop

```sh
bun install
bun test
bun run --filter @ponzu/studio build
bun apps/cli/src/index.ts serve examples/halon.design examples/kettle.design examples/weft.design
```

[`examples/`](examples) holds three made-up companies to try Ponzu on: Halon (incident response for engineering teams), Kettle (an iPhone app for people who live together) and Weft (a sync platform for developers). Each has a brand, architecture diagrams, a website and an app, with its brief in `notes/brief.md`.

For studio work, run `bun run dev`: the studio with hot reload on all three examples.

Run from a checkout, `serve` stays out of the installed app's way: it listens on a port in 7800–7999 derived from the checkout's path (the same every run, different per worktree, the next free one if it's taken), and not on the tailnet, so your iPhone and other Macs keep finding the app, not a dev server. `--port` picks a port; `--tailnet` answers the phone and other Macs too, for testing against them (the app's tailnet port must be free). The studio's dev server proxies to the checkout's port; `PONZU_SERVER=<url>` points it elsewhere.

Desktop: `cd apps/desktop && bun run start`. iPhone: `cd apps/mobile && bunx expo run:ios` ([docs/mobile.md](docs/mobile.md)).

PR titles are Conventional Commits, and merging a `feat` or `fix` ships a signed release on its own. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Brand and press

Ponzu's own brand lives in this repo as `.design` folders under [`design/`](design), and opens on the canvas in your browser:

- [Brand](https://ponzu.design/gh/north-brook/ponzu/design/brand.design): the slice, the lockup, the app icon, color, type, motion and voice.
- [Press kit](https://ponzu.design/gh/north-brook/ponzu/design/press-kit.design): a description and the facts, logos, product shots and social images, ready to export.
- [Design system](https://ponzu.design/gh/north-brook/ponzu/design/components.design): the studio's bars, buttons, menus, comments and icons, in light and dark.

[All three](https://ponzu.design/gh/north-brook/ponzu/design). Each one's `notes/brief.md` says where its source of truth lives in the code.

## License

MIT
