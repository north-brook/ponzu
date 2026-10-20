<p align="center"><img src="apps/site/public/favicon.svg" width="72" height="72" alt=""></p>

<h1 align="center">Ponzu</h1>

<p align="center">The design canvas for your coding agent.<br>Open source. Runs on your machine. Your agent designs in plain HTML and CSS, and you steer with comments.</p>

<p align="center"><a href="https://ponzu.design">ponzu.design</a> · <a href="#connect-an-agent">Connect an agent</a> · <a href="#the-design-format">The .design format</a> · <a href="#embed-it">Embed it</a></p>

---

Ponzu is an infinite canvas of artboards. Agents draw on it over MCP, writing HTML and CSS, and you watch it happen live. You leave comments on the canvas; the agent picks them up, makes the change, and replies. There are no manual editing panels. If you want something changed, you ask.

- **Free forever.** MIT. No account, no seats, no limits. Bring the agent you already use.
- **Your files, your workflow.** A `.design` is a folder of HTML files on your disk. Commit it next to your code, sync it through Dropbox, or toss it.
- **Just HTML and CSS.** If a browser can do it, so can your design: grid, gradients, variable fonts, video, real animation.

## Quick start

```sh
bunx ponzu serve
```

This opens the canvas in your browser and serves MCP at `http://127.0.0.1:7777/mcp`. Every `.design` folder under the current directory is opened.

Or download the Mac app from [Releases](https://github.com/north-brook/ponzu/releases/latest). It opens `.design` folders like documents.

## Connect an agent

```sh
ponzu install claude   # Claude Code
ponzu install codex    # Codex
ponzu install cursor   # Cursor
```

These register `http://127.0.0.1:7777/mcp` (streamable HTTP) with the agent. Any other MCP client works too, either over HTTP while `ponzu serve` runs or by launching `bunx ponzu mcp` over stdio.

Then ask for something:

> Design a landing page for a houseplant shop in a new `design/shop.design`. Give me three takes on the hero.

To pair on feedback, use the `collaborate` prompt (or say "run the Ponzu collaborate loop"). The agent waits for your comments, handles each one, and replies in the thread.

### Reach it from another machine

```sh
ponzu serve --host 0.0.0.0     # or your tailnet IP
```

Ponzu has no auth. Bind beyond localhost only on networks you trust, such as a tailnet.

## The design format

A `.design` is a folder. macOS shows it as a single document; everything else sees a directory.

```
fernwood.design/
  design.json          { "ponzu": 1, "name": "Fernwood", "pages": [{ "id", "name", "icon" }] }
  tokens.css           :root { --color-ink: #111; … }
  comments.json        comment threads, pinned to node ids
  notes/brief.md       notes the agent keeps between sessions
  assets/              images and fonts
  pages/
    home/
      hero.html        one artboard per file
```

Each artboard file holds one `<section data-artboard>`:

```html
<section data-artboard data-id="ab_hero" data-name="Hero" data-x="0" data-y="0" style="width:1440px;height:900px">
  <h1 data-id="n_k3x9q" data-name="Headline" style="font:600 64px/1.1 var(--font-display)">Plants that outlive your lease</h1>
</section>
```

- **Edit it however you like.** Ponzu watches the folder. An edit from your editor, `sed` or another agent shows up live and becomes an event agents can react to.
- **Ids are lazy.** Hand-written elements get stable ids derived from their position. Ponzu writes an id into a file only when something needs to point at it.
- **Inert by default.** `<script>`, `on*` handlers and `javascript:` URLs are stripped on load.
- **Fonts just work.** Google Fonts named in `font-family` load automatically on the canvas and in screenshots.

To implement a design, point your coding agent at the folder. The HTML, tokens and comments are the spec.

## Embed it

Ponzu is a set of packages you can build into your own product:

| Package | What it does |
| --- | --- |
| `@ponzu/core` | HTML ↔ node tree, ops with inverses (undo, change feed), sanitizer |
| `@ponzu/store` | Opens a `.design` from any storage; diffs outside edits into ops |
| `@ponzu/tools` | The agent tools as transport-agnostic `{ name, schema, handler }` |
| `@ponzu/mcp` | Those tools over MCP (stdio and streamable HTTP) |
| `@ponzu/render` | Screenshots plus a layout lint pass. Uses Chromium, an Electron window, or your own renderer |
| `@ponzu/react` | `<Canvas>`. Renders artboards with the host page's own engine, in shadow roots |
| `@ponzu/server` | The local host behind `ponzu serve` |

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
| Orient | `get_basic_info` `get_selection` `get_tree` `get_node` `get_html` `find_nodes` |
| Write | `create_artboard` `write_html` `update_styles` `set_text` `set_attributes` `duplicate` `move_nodes` `delete` `rename` `update_artboard` |
| See | `screenshot` (with lint) `export` |
| Organize | `list_files` `create_file` `create_page` `update_page` `archive` `get_tokens` `set_tokens` |
| Converse | `list_comments` `get_comment` `create_comment` `reply` `set_comment_status` |
| Listen + remember | `wait_for_activity` `start_working` `finish_working` `write_note` `read_notes` `get_guide` |

Skills for agents that support them live in [`skills/`](skills).

## Develop

```sh
bun install
bun test
bun run --filter @ponzu/studio build
bun apps/cli/src/index.ts serve examples/fernwood.design
```

For studio work, run `bun apps/cli/src/index.ts serve examples/fernwood.design --dev` and `bun run --filter @ponzu/studio dev` side by side.

Desktop: `cd apps/desktop && bun run start`.

## License

MIT
