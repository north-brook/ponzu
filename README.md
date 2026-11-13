<p align="center"><img src="apps/web/public/favicon.svg" width="72" height="72" alt=""></p>

<h1 align="center">Ponzu</h1>

<p align="center">Make it on the canvas, ship it to your repo.<br>Claude works on a canvas in its own cloud sandbox, and you steer it with comments.</p>

<p align="center"><a href="https://ponzu.design">ponzu.design</a> · <a href="https://ponzu.design/download">Download</a> · <a href="https://ponzu.design/pricing">Pricing</a></p>

---

Ponzu is an app for making things with Claude: brands, apps, launch pages, diagrams, dashboards, whole features. Each canvas is an infinite board of artboards that Claude draws in plain HTML and CSS while you watch. Pin a comment on anything, and Ponzu makes the change and answers in the thread. A canvas can start from one of your GitHub repositories, where it works on its own branch and you open, check and merge its pull request from the canvas, or from scratch.

## Get started

1. [Download Ponzu for Mac](https://ponzu.design/download) (Apple silicon, signed and notarized; it updates itself). Windows and Linux builds are in beta on the same page.
2. Sign in with GitHub, then choose where you build: install Ponzu's GitHub App on your own account or an organization, or use one your team has already set up. Each account Ponzu is installed on is a workspace.
3. Connect Claude: your Claude Pro or Max subscription, or an Anthropic API key. Claude runs on your plan, and Ponzu adds nothing for tokens.
4. Pick a repository or start from scratch.

Ponzu is free while billing is being set up.

## On your iPhone

Ponzu for iPhone is in [TestFlight](https://ponzu.design/iphone). See your canvases live and comment on them from your iPhone.

## From your own agent

Claude Code and Codex can use Ponzu as a plugin: hand a canvas to Ponzu's agent, or drive one yourself, then build what was settled in your own checkout and link the pull request to the canvas. The plugin connects to Ponzu's MCP server at `https://api.ponzu.design/v1/mcp` and adds skills for starting from a brief, exploring variations, bringing a screen in from code, product shots, implementing a canvas and watching comments.

```sh
# Claude Code, then sign in to ponzu from /mcp
claude plugin marketplace add north-brook/ponzu
claude plugin install ponzu@ponzu

# Codex
codex plugin marketplace add north-brook/ponzu
codex plugin add ponzu@ponzu
codex mcp login ponzu
```

Signing in opens Ponzu, which asks you to allow the agent. The plugin lives in [`plugin/`](plugin).

## Ponzu 1

Ponzu 1 was a local app that kept designs in `.design` folders. Its last release is [v1.80.1](https://github.com/north-brook/ponzu/releases/tag/v1.80.1). The `.design` folders it made stay on your computer; this version doesn't open them.

## The repository

[docs/cloud.md](docs/cloud.md) is the specification. The apps live in `apps/` (the API, the Mac app and its studio, the iPhone app, the website and the sandbox runner) and the shared packages in `packages/`. Several have their own README.

```sh
bun install
bun test
bun run dev
```

`bun run dev` is the studio with hot reload, on Ponzu Cloud in memory. The iPhone app is in [docs/mobile.md](docs/mobile.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull request titles are Conventional Commits, and pull requests are squash-merged. Ponzu's own brand, press kit and design system are in [`design/`](design).

## License

MIT
