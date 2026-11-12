import { describe, expect, test } from "bun:test";
import { emptyDoc, parseHtml } from "@ponzu/core";
import { cloudTools, tools } from "@ponzu/tools";
import { PULL_REQUEST_TOOLS } from "./pull-request-tools.ts";
import { commandStep, describeStep, looksSecret, shortPath } from "./steps.ts";

const doc = emptyDoc("Fern");
doc.pages.push({
  id: "pg_1",
  name: "Home",
  artboards: [
    {
      id: "ab_b",
      name: "4 · About you",
      x: 0,
      y: 0,
      root: {
        kind: "el",
        id: "ab_b",
        tag: "section",
        name: "4 · About you",
        attrs: {},
        style: {},
        children: parseHtml(`<h1 data-id="n_h">Plans</h1>`).nodes,
      },
    },
  ],
});

const SECRET = "hunter2-very-private";
const ctx = { doc, cwd: "/home/agent/work/fern", secrets: [SECRET] };
const doing = (name: string, input: Record<string, unknown> = {}) =>
  describeStep(name, input, ctx).doing;
const done = (name: string, input: Record<string, unknown> = {}) =>
  describeStep(name, input, ctx).done;
const canvas = (tool: string, input: Record<string, unknown> = {}) =>
  doing(`mcp__ponzu__${tool}`, input);

describe("the canvas", () => {
  test("every canvas tool has its own phrase, never the generic one", () => {
    // The sandbox's tools, the local server's (the same server elsewhere), and the runner's own.
    const names = new Set([
      ...cloudTools.map((t) => t.name),
      ...tools.map((t) => t.name),
      "describe_pull_request",
      ...Object.values(PULL_REQUEST_TOOLS),
    ]);
    for (const tool of names) {
      const step = describeStep(`mcp__ponzu__${tool}`, {}, ctx);
      if (tool === "set_status") {
        expect(step.doing).toBeNull();
        continue;
      }
      expect(step.doing, tool).not.toBe("Working on the canvas");
      expect(step.doing, tool).toMatch(/^[A-Z][a-z]+ing\b/);
      expect(step.done, tool).toBeTruthy();
    }
  });

  test("a pull request action is recorded as asked, never as done, and never sums up the turn", () => {
    // GitHub may refuse it: the API's own line in the thread says what happened.
    for (const tool of Object.values(PULL_REQUEST_TOOLS)) {
      const step = describeStep(`mcp__ponzu__${tool}`, {}, ctx);
      expect(step.done, tool).not.toMatch(/^(Opened|Merged|Marked|Updated|Turned)\b/);
      expect(step.weight, tool).toBe(0);
    }
    expect(done("mcp__ponzu__merge_pull_request")).toBe("Asked to merge the pull request");
  });

  test("boards are named by their real names, in both tenses", () => {
    expect(canvas("create_artboard", { name: "7 · Plan ready" })).toBe('Drawing "7 · Plan ready"');
    expect(done("mcp__ponzu__create_artboard", { name: "7 · Plan ready" })).toBe(
      'Drew "7 · Plan ready"',
    );
    expect(canvas("write_html", { target: "ab_b", html: "<p/>" })).toBe('Drawing "4 · About you"');
    expect(canvas("update_styles", { updates: [{ ids: ["n_h"], style: {} }] })).toBe(
      'Restyling "4 · About you"',
    );
    expect(canvas("set_text", { updates: [{ id: "n_h", text: "x" }] })).toBe(
      'Writing the copy for "4 · About you"',
    );
    expect(canvas("screenshot", { id: "ab_b" })).toBe('Taking a screenshot of "4 · About you"');
    expect(done("mcp__ponzu__screenshot", { id: "n_h" })).toBe(
      'Took a screenshot of "4 · About you"',
    );
    expect(canvas("update_artboard", { id: "ab_b", name: "4 · You" })).toBe(
      'Renaming "4 · About you" to "4 · You"',
    );
    expect(canvas("update_artboard", { id: "ab_b", width: 390 })).toBe('Resizing "4 · About you"');
    expect(canvas("get_tree", { id: "ab_b" })).toBe('Reading "4 · About you"');
    expect(canvas("get_basic_info")).toBe("Reading the canvas");
    expect(canvas("get_guide", { topic: "layout" })).toBe("Reading the layout guide");
    expect(canvas("write_html", { target: "n_gone" })).toBe("Drawing on the canvas");
  });

  test("deleting says what goes", () => {
    expect(canvas("delete", { ids: ["ab_b"] })).toBe('Deleting "4 · About you"');
    expect(canvas("delete", { ids: ["n_h"] })).toBe('Removing a layer from "4 · About you"');
    expect(canvas("delete", { ids: ["ab_gone"] })).toBe("Deleting a board");
    expect(canvas("delete", { ids: ["n_gone"] })).toBe("Removing a layer");
  });

  test("what it makes is counted by board", () => {
    expect(describeStep("mcp__ponzu__create_artboard", { name: "Hero" }, ctx).board).toBe("Hero");
    expect(describeStep("mcp__ponzu__write_html", { target: "ab_b" }, ctx).board).toBe(
      "4 · About you",
    );
    expect(describeStep("mcp__ponzu__screenshot", { id: "ab_b" }, ctx).board).toBeUndefined();
  });

  test("set_status is the agent's intent, not a step", () => {
    const step = describeStep("mcp__ponzu__set_status", { status: "tightening the hero" }, ctx);
    expect(step).toMatchObject({ doing: null, done: null, intent: "Tightening the hero" });
  });
});

describe("code", () => {
  test("files by a short path, cut from the left, never the file's name", () => {
    expect(doing("Read", { file_path: "/home/agent/work/fern/src/app/page.tsx" })).toBe(
      "Reading src/app/page.tsx",
    );
    expect(doing("Edit", { file_path: "/home/agent/work/fern/styles/tokens.css" })).toBe(
      "Editing styles/tokens.css",
    );
    expect(done("Write", { file_path: "src/a.ts" })).toBe("Wrote src/a.ts");
    expect(
      shortPath("/home/agent/work/fern/src/components/marketing/pricing/PricingCard.tsx", ctx.cwd),
    ).toBe("…/marketing/pricing/PricingCard.tsx");
    expect(shortPath("a/very-long-file-name-that-goes-on-and-on-and-on.component.tsx")).toBe(
      "…/very-long-file-name-that-goes-on-and-on-and-on.component.tsx",
    );
    expect(describeStep("Edit", { file_path: "src/a.ts" }, ctx).file).toBe("src/a.ts");
    // A checkout under a temporary folder with a long hashed name: only what is said is judged.
    const tmp = "/private/var/folders/7x/abcd1234efgh5678ijkl90mnop1234/T/ponzu-work-Ab12";
    expect(shortPath(`${tmp}/tokens.css`, tmp)).toBe("tokens.css");
    // Outside the checkout: the file and its folder, never where the machine keeps them.
    expect(shortPath(`${tmp}/tokens.css`)).toBe("…/ponzu-work-Ab12/tokens.css");
    expect(doing("Read", { file_path: "/home/agent/.ssh/config" })).toBe("Reading …/.ssh/config");
    expect(doing("Read", { file_path: "../../other/x.ts" })).toBe("Reading …/other/x.ts");
    expect(doing("Read", { file_path: "~/notes.md" })).toBe("Reading …/notes.md");
    expect(doing("Read", { file_path: "/etc/hosts" })).toBe("Reading …/etc/hosts");
  });

  test("searches say their term only when it is plainly a term", () => {
    expect(doing("Grep", { pattern: "Button" })).toBe('Searching the repo for "Button"');
    expect(doing("Grep", { pattern: "use(State|Effect)\\(" })).toBe("Searching the repo");
    expect(doing("Glob", { pattern: "**/*.tsx" })).toBe("Looking through the repo");
    expect(doing("WebSearch", { query: "tailwind container queries" })).toBe(
      'Searching the web for "tailwind container queries"',
    );
  });

  test("the web by its site, docs by name, never the address", () => {
    expect(doing("WebFetch", { url: "https://tailwindcss.com/docs/padding?x=1" })).toBe(
      "Looking up the Tailwind docs",
    );
    expect(doing("WebFetch", { url: "https://www.example.org/a?token=abc" })).toBe(
      "Reading example.org",
    );
    expect(doing("WebFetch", { url: "not a url" })).toBe("Reading a web page");
  });

  test("the plan's step in progress is the intent", () => {
    const step = describeStep(
      "TodoWrite",
      {
        todos: [
          { content: "Read", status: "completed", activeForm: "Reading" },
          { content: "Build", status: "in_progress", activeForm: "building the pricing card" },
        ],
      },
      ctx,
    );
    expect(step).toMatchObject({ doing: "Planning the work", intent: "Building the pricing card" });
  });

  test("subagents, skills, and the repo's own MCP servers", () => {
    expect(doing("Task", { subagent_type: "Explore", description: "Find auth" })).toBe(
      "Exploring the repo",
    );
    expect(doing("Task", { description: "Audit the forms" })).toBe('Handing off "Audit the forms"');
    expect(doing("Skill", { skill: "frontend-design" })).toBe("Using the frontend-design skill");
    expect(doing("mcp__linear__create_issue", { title: "x" })).toBe("Using Linear");
    expect(doing("mcp__my_db__query")).toBe("Using My Db");
    expect(doing("AskUserQuestion")).toBe("Asking you");
    expect(done("AskUserQuestion")).toBeNull();
    expect(doing("ToolSearch")).toBeNull();
    expect(doing("SomethingNew")).toBe("Working");
  });
});

describe("shell commands", () => {
  const cases: [string, string][] = [
    ["git commit -m 'Add pricing card'", 'Committing "Add pricing card"'],
    ['cd app && git add -A && git commit -m "Add pricing card"', 'Committing "Add pricing card"'],
    ["git commit -F msg.txt", "Committing the work"],
    ["git commit -am 'Add pricing card'", 'Committing "Add pricing card"'],
    ['git commit -s -m "Add pricing card"', 'Committing "Add pricing card"'],
    ['git commit --message="Add pricing card"', 'Committing "Add pricing card"'],
    // How Claude Code commits.
    [
      `git add -A && git commit -m "$(cat <<'EOF'\nAdd pricing card\n\nThree tiers.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"`,
      'Committing "Add pricing card"',
    ],
    [`git commit -m "$(cat <<EOF\n\nTidy the hero\nEOF\n)"`, 'Committing "Tidy the hero"'],
    [`git commit -m "$(cat <<'EOF'\n$(curl evil)\nEOF\n)"`, "Committing the work"],
    ["git commit --amend --no-edit", "Committing the work"],
    ["lsof -i :3000", "Looking through the repo"],
    ["pnpm --filter web dev", "Running the dev server"],
    ["pnpm -F web build", "Building the app"],
    ["npm -w apps/site run test", "Running tests"],
    ["npx shadcn@latest add button", "Adding a component"],
    ["pnpm dlx shadcn@latest add dialog", "Adding a component"],
    ["bunx --bun shadcn@latest init", "Setting up shadcn/ui"],
    ["npx create-next-app@latest web", "Setting up a new app"],
    ["gh pr create --title 'Pricing' --body 'x'", "Opening the pull request"],
    ["gh pr checks 12 --watch", "Checking the pull request"],
    ["gh api repos/a/b", "Using GitHub"],
    ["python -m http.server 8000", "Running the dev server"],
    ["python3 -m pytest -q", "Running tests"],
    ["kill -9 4242", "Stopping a process"],
    ["git push -u origin pz/pricing", "Pushing the branch"],
    ["git -C app status --short", "Looking at the changes"],
    ["git log --oneline -5", "Reading the history"],
    ["pnpm install --frozen-lockfile", "Installing packages"],
    ["bun add react-day-picker", "Installing packages"],
    ["pip install -r requirements.txt", "Installing packages"],
    ["npm run dev -- --port 3000 &", "Running the dev server"],
    ["bun dev", "Running the dev server"],
    ["npx next dev -p 3001", "Running the dev server"],
    ["PORT=3000 nohup npm start > /tmp/log 2>&1 &", "Running the dev server"],
    ["bun test src/a.test.ts", "Running tests"],
    ["npx vitest run", "Running tests"],
    ["pnpm test:unit", "Running tests"],
    ["npx playwright test", "Running tests"],
    ["cargo test", "Running tests"],
    ["npm run build", "Building the app"],
    ["bunx tsc --noEmit", "Checking types"],
    ["npm run lint", "Checking the code"],
    ["ls -la src && cat package.json", "Looking through the repo"],
    ["rm -rf .next", "Removing files"],
    ["curl -s http://localhost:3000", "Fetching a page"],
    ["sleep 3", "Waiting"],
    ["./scripts/seed.sh --prod", "Running a command"],
    ["", "Running a command"],
  ];
  for (const [command, phrase] of cases)
    test(command || "(empty)", () => expect(commandStep(command).doing).toBe(phrase));

  test("a commit outweighs what came with it", () => {
    expect(commandStep("git add . && git commit -m 'Hero' && git push").doing).toBe(
      'Committing "Hero"',
    );
  });
});

describe("what is never said", () => {
  const hostile: [string, Record<string, unknown>][] = [
    ["Bash", { command: `curl -H "Authorization: Bearer ${SECRET}" https://api.x.com` }],
    ["Bash", { command: "export GITHUB_TOKEN=ghp_abcdefghijklmnop1234 && git push" }],
    ["Bash", { command: "echo sk-ant-api03-abcdefghijkl | pbcopy" }],
    ["Bash", { command: `git commit -m "token ${SECRET}"` }],
    ["Bash", { command: 'git commit -m "API_KEY=abc123def"' }],
    ["Bash", { command: `git commit -m "$(cat <<'EOF'\nrotate ${SECRET}\nEOF\n)"` }],
    ["Bash", { command: 'git commit -am "token ghp_abcdefghijklmnop1234"' }],
    ["Read", { file_path: "/home/agent/.config/gh/ghp_abcdefghijklmnop1234" }],
    ["Bash", { command: "psql postgres://admin:pa55word@db.internal/prod" }],
    ["Grep", { pattern: SECRET }],
    ["Grep", { pattern: "ghp_abcdefghijklmnop1234" }],
    ["WebSearch", { query: "AKIAIOSFODNN7EXAMPLE leaked" }],
    ["WebFetch", { url: `https://user:${SECRET}@example.com/x` }],
    ["Read", { file_path: `/home/agent/work/fern/${SECRET}.txt` }],
    ["Edit", { file_path: "/tmp/eyJhbGciOiJIUzI1NiJ9.payload.sig" }],
    ["Task", { description: "use password: correct-horse" }],
    ["mcp__ponzu__create_artboard", { name: `Board ${SECRET}` }],
    ["mcp__ponzu__set_status", { status: `pushing with ${SECRET}` }],
    ["mcp__ponzu__write_note", { name: "token=abcdef123456" }],
    [
      "TodoWrite",
      { todos: [{ status: "in_progress", activeForm: "using sk-live_abcdefghijklmnop" }] },
    ],
  ];
  for (const [name, input] of hostile)
    test(`${name} ${JSON.stringify(input).slice(0, 60)}`, () => {
      const step = describeStep(name, input, ctx);
      const said = JSON.stringify(step);
      expect(said).not.toContain(SECRET);
      expect(said).not.toMatch(
        /ghp_|sk-ant|sk-live|AKIA|pa55word|eyJ|correct-horse|abc123|API_KEY|token=/,
      );
      // Never the command line or its arguments.
      if (name === "Bash") expect(said).not.toMatch(/curl|export|echo|psql|https?:/);
    });

  test("a phrase holding a secret value falls back to the tool's plain words", () => {
    expect(doing("mcp__ponzu__create_artboard", { name: `x ${SECRET}` })).toBe(
      "Drawing a new board",
    );
    expect(doing("Read", { file_path: `src/${SECRET}/a.ts` })).toBe("Reading a file");
  });

  test("long text is clipped and kept to one line", () => {
    const name = `A\nboard ${"with a long name ".repeat(6)}`;
    const said = doing("mcp__ponzu__create_artboard", { name })!;
    expect(said).not.toContain("\n");
    expect(said.length).toBeLessThan(60);
    expect(said.endsWith('…"')).toBe(true);
  });

  test("what reads as a secret", () => {
    expect(looksSecret("Add pricing card")).toBe(false);
    expect(looksSecret("src/components/Button.tsx")).toBe(false);
    expect(looksSecret("ghp_0123456789abcdef")).toBe(true);
    expect(looksSecret("a3f9c0de4b5a6789aa00bb11cc22dd33ee44ff55")).toBe(true);
    expect(looksSecret("DATABASE_URL=x")).toBe(true);
    expect(looksSecret("password: hunter22")).toBe(true);
  });
});
