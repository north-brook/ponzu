import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configFor } from "./config.ts";
import {
  invocation,
  type LegacyHost,
  removeLegacy,
  removeLegacyFor,
  removeLegacyOnce,
  shimServers,
} from "./legacy.ts";
import { built } from "./testing.ts";

/*
 * Each case lays out a home folder the way Ponzu 1.x left it (its CLI's install.ts,
 * command.ts, host.ts, wake.ts write these exact forms) and checks what goes and what stays.
 */

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The shim 1.x wrote on a Mac for an app at `app`, as host.ts's shimScript does. */
const macShim = (app: string) => `#!/bin/sh
# Written by Ponzu. Runs the server inside the installed Ponzu.app, so it updates with the app.
for app in '${app.replace(/'/g, `'\\''`)}' /Applications/Ponzu.app "$HOME/Applications/Ponzu.app"; do
  bin="$app/Contents/Resources/server/ponzu"
  [ -x "$bin" ] && exec "$bin" "$@"
done
echo "Ponzu isn't installed. Download it from https://ponzu.design" >&2
exit 1
`;

const wakePlist = (program: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>design.ponzu.app.wake</string>
  <key>ProgramArguments</key>
  <array>
    <string>${program}</string>
    <string>wake</string>
  </array>
</dict>
</plist>
`;

/** A home on `platform` with agents' CLIs in ~/.local/bin, played by `answer`. */
function machine(platform: NodeJS.Platform = "darwin") {
  const home = mkdtempSync(join(tmpdir(), "ponzu-home-"));
  homes.push(home);
  const shim = join(home, ".ponzu/bin/ponzu");
  const calls: string[] = [];
  let codexTransport: unknown = null;
  const host: LegacyHost = {
    platform,
    home,
    env: { PATH: "" },
    uid: 501,
    // This computer's own programs (a real Ponzu, a real Claude Code) are none of the test's.
    exists: (path) => path.startsWith(home) && existsSync(path),
    async run(command, args) {
      const name = command.split("/").pop()!;
      calls.push(`${name} ${args.join(" ")}`);
      if (name === "codex" && args[1] === "get") {
        return codexTransport
          ? { status: 0, stdout: JSON.stringify({ name: "ponzu", transport: codexTransport }) }
          : { status: 1, stdout: "" };
      }
      return { status: 0, stdout: "" };
    },
  };
  return {
    home,
    shim,
    host,
    calls,
    agents() {
      put(join(home, ".local/bin/claude"), "");
      put(join(home, ".local/bin/codex"), "");
    },
    codex(transport: unknown) {
      codexTransport = transport;
    },
  };
}

test("everything 1.x wired up to its dead server goes, and nothing else does", async () => {
  const m = machine();
  m.agents();
  const app = join(m.home, "Gone/Ponzu.app");
  put(m.shim, macShim(app));
  mkdirSync(join(m.home, ".local/bin"), { recursive: true });
  symlinkSync(m.shim, join(m.home, ".local/bin/ponzu"));
  put(join(m.home, "elsewhere/ponzu"), "#!/bin/sh\n");
  mkdirSync(join(m.home, "bin"));
  symlinkSync(join(m.home, "elsewhere/ponzu"), join(m.home, "bin/ponzu"));
  put(
    join(m.home, ".claude.json"),
    JSON.stringify({ mcpServers: { ponzu: { type: "stdio", command: m.shim, args: ["mcp"] } } }),
  );
  m.codex({ type: "stdio", command: m.shim, args: ["mcp"] });
  put(
    join(m.home, ".cursor/mcp.json"),
    JSON.stringify({
      mcpServers: {
        ponzu: { command: m.shim, args: ["mcp"] },
        figma: { url: "http://127.0.0.1:3845/mcp" },
      },
    }),
  );
  const plist = join(m.home, "Library/LaunchAgents/design.ponzu.app.wake.plist");
  put(plist, wakePlist(join(app, "Contents/Resources/server/ponzu")));
  put(join(m.home, "Designs/landing.design/design.json"), "{}");

  const steps = await removeLegacy(m.host);

  expect(steps.filter((s) => s.outcome === "removed").map((s) => s.what)).toEqual([
    join(m.home, ".local/bin/ponzu"),
    m.shim,
    "Claude Code's ponzu MCP server",
    "Codex's ponzu MCP server",
    "Cursor's ponzu MCP server",
    plist,
  ]);
  expect(m.calls).toEqual([
    "claude mcp remove --scope user ponzu",
    "codex mcp get ponzu --json",
    "codex mcp remove ponzu",
    "launchctl bootout gui/501/design.ponzu.app.wake",
  ]);
  expect(existsSync(m.shim)).toBe(false);
  expect(existsSync(join(m.home, ".ponzu/bin"))).toBe(false);
  expect(() => lstatSync(join(m.home, ".local/bin/ponzu"))).toThrow();
  expect(existsSync(plist)).toBe(false);
  // The person's own: a link to another ponzu, Cursor's other server, their designs.
  expect(lstatSync(join(m.home, "bin/ponzu")).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(join(m.home, ".cursor/mcp.json"), "utf8"))).toEqual({
    mcpServers: { figma: { url: "http://127.0.0.1:3845/mcp" } },
  });
  expect(existsSync(join(m.home, "Designs/landing.design/design.json"))).toBe(true);
});

test("a 1.x Ponzu still installed keeps everything it uses", async () => {
  const m = machine();
  m.agents();
  const app = join(m.home, "Apps/Ponzu.app");
  put(join(app, "Contents/Resources/server/ponzu"), "");
  put(m.shim, macShim(app));
  put(
    join(m.home, ".claude.json"),
    JSON.stringify({ mcpServers: { ponzu: { command: m.shim, args: ["mcp"] } } }),
  );
  const steps = await removeLegacy(m.host);
  expect(steps).toEqual([
    {
      what: m.shim,
      outcome: "kept",
      why: `Ponzu 1.x is still installed at ${join(app, "Contents/Resources/server/ponzu")}`,
    },
  ]);
  expect(m.calls).toEqual([]);
  expect(existsSync(m.shim)).toBe(true);
});

test("what someone else wrote stays, even under the names 1.x used", async () => {
  const m = machine();
  m.agents();
  put(m.shim, '#!/bin/sh\nexec ~/src/ponzu/run "$@"\n');
  put(
    join(m.home, ".claude.json"),
    JSON.stringify({
      mcpServers: { ponzu: { command: m.shim, args: ["mcp"] } },
    }),
  );
  // A server of their own named ponzu, and a URL to a Ponzu elsewhere.
  m.codex({ type: "stdio", command: "/usr/local/bin/my-ponzu", args: ["mcp"] });
  put(
    join(m.home, ".cursor/mcp.json"),
    JSON.stringify({ mcpServers: { ponzu: { url: "http://127.0.0.1:7777/mcp" } } }),
  );
  const plist = join(m.home, "Library/LaunchAgents/design.ponzu.app.wake.plist");
  put(plist, wakePlist("/usr/local/bin/something-else"));

  const steps = await removeLegacy(m.host);

  expect(steps.filter((s) => s.outcome !== "kept")).toEqual([]);
  expect(m.calls).toEqual(["codex mcp get ponzu --json"]);
  expect(existsSync(m.shim)).toBe(true);
  expect(existsSync(plist)).toBe(true);
});

test("a registration is removed by its agent's own CLI, or left with the reason", async () => {
  const m = machine();
  put(
    join(m.home, ".claude.json"),
    JSON.stringify({ mcpServers: { ponzu: { command: m.shim, args: ["mcp"] } } }),
  );
  const steps = await removeLegacy(m.host);
  expect(steps).toEqual([
    {
      what: "Claude Code's ponzu MCP server",
      outcome: "failed",
      why: "the claude command wasn't found",
    },
  ]);
});

test("Linux: the wake helper's systemd units, when the server they start is gone", async () => {
  const m = machine("linux");
  const units = join(m.home, ".config/systemd/user");
  put(
    join(units, "ponzu-wake@.service"),
    `[Unit]\nDescription=Ponzu wake helper\n\n[Service]\nExecStart="/opt/Ponzu/resources/server/ponzu" wake\nStandardInput=socket\n`,
  );
  put(join(units, "ponzu-wake.socket"), "[Socket]\nListenStream=7778\n");
  mkdirSync(join(units, "sockets.target.wants"));
  symlinkSync(
    join(units, "ponzu-wake.socket"),
    join(units, "sockets.target.wants/ponzu-wake.socket"),
  );

  const steps = await removeLegacy(m.host);

  expect(steps.map((s) => [s.what, s.outcome])).toEqual([
    [join(units, "sockets.target.wants/ponzu-wake.socket"), "removed"],
    [join(units, "ponzu-wake.socket"), "removed"],
    [join(units, "ponzu-wake@.service"), "removed"],
  ]);
  expect(m.calls).toEqual([
    "systemctl --user disable --now ponzu-wake.socket",
    "systemctl --user daemon-reload",
  ]);
});

test("the servers each form of 1.x's shim runs", () => {
  const host = { home: "/Users/me", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } };
  expect(shimServers(macShim("/Users/me/Ponzu's Apps/Ponzu.app"), host)).toEqual([
    "/Users/me/Ponzu's Apps/Ponzu.app/Contents/Resources/server/ponzu",
    "/Applications/Ponzu.app/Contents/Resources/server/ponzu",
    "/Users/me/Applications/Ponzu.app/Contents/Resources/server/ponzu",
  ]);
  const linux = `#!/bin/sh
# Written by Ponzu. Runs the server inside the installed Ponzu, so it updates with the app.
for bin in '/opt/Ponzu/resources/server/ponzu' '/home/me/.ponzu/app/ponzu'; do
  [ -x "$bin" ] && exec "$bin" "$@"
done
`;
  expect(shimServers(linux, host)).toEqual([
    "/opt/Ponzu/resources/server/ponzu",
    "/home/me/.ponzu/app/ponzu",
  ]);
  const windows = [
    "@echo off",
    "rem Written by Ponzu. Runs the server inside the installed Ponzu, so it updates with the app.",
    "setlocal",
    'if exist "%LOCALAPPDATA%\\Programs\\ponzu\\resources\\server\\ponzu.exe" (',
    '  set "bin=%LOCALAPPDATA%\\Programs\\ponzu\\resources\\server\\ponzu.exe"',
    "  goto run",
    ")",
    "",
  ].join("\r\n");
  expect(shimServers(windows, host)).toEqual([
    "C:\\Users\\me\\AppData\\Local\\Programs\\ponzu\\resources\\server\\ponzu.exe",
  ]);
  expect(shimServers("#!/bin/sh\nexec ponzu-dev\n", host)).toBeNull();
});

test("a step whose program won't even start fails alone, and the rest still run and are recorded", async () => {
  const m = machine();
  m.agents();
  put(
    join(m.home, ".cursor/mcp.json"),
    JSON.stringify({ mcpServers: { ponzu: { command: m.shim, args: ["mcp"] } } }),
  );
  // As Node does for a Windows .cmd started without a shell: it throws, it doesn't exit.
  m.host.run = () => {
    throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
  };
  const record = join(m.home, "userData/legacy-cleanup.json");
  mkdirSync(dirname(record), { recursive: true });

  const steps = await removeLegacyOnce(m.host, record, "2.0.0");

  expect(steps?.map((s) => [s.what, s.outcome])).toEqual([
    ["Codex's ponzu MCP server", "failed"],
    ["Cursor's ponzu MCP server", "removed"],
  ]);
  expect(steps?.[0]?.why).toContain("spawn EINVAL");
  expect(JSON.parse(readFileSync(record, "utf8")).steps).toEqual(steps);
});

test("Cursor's file keeps its mode and indent, and a link to the person's dotfiles stays a link", async () => {
  const m = machine();
  const file = join(m.home, ".cursor/mcp.json");
  const servers = (ponzu: boolean) => ({
    mcpServers: {
      ...(ponzu ? { ponzu: { command: m.shim, args: ["mcp"] } } : {}),
      figma: { url: "http://127.0.0.1:3845/mcp" },
    },
  });
  put(file, `${JSON.stringify(servers(true), null, "\t")}\n`);
  chmodSync(file, 0o640);
  await removeLegacy(m.host);
  expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(servers(false), null, "\t")}\n`);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o640);

  const dotfiles = join(m.home, "dotfiles/cursor/mcp.json");
  put(dotfiles, JSON.stringify(servers(true)));
  rmSync(file);
  symlinkSync(dotfiles, file);
  const steps = await removeLegacy(m.host);
  expect(steps).toEqual([
    {
      what: "Cursor's ponzu MCP server",
      outcome: "kept",
      why: `${file} is a link, which Ponzu leaves to its owner`,
    },
  ]);
  expect(lstatSync(file).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(dotfiles, "utf8"))).toEqual(servers(true));
});

test("on Windows an npm agent's .cmd runs through cmd.exe, with nothing but its fixed arguments", () => {
  const claude = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd";
  expect(invocation(claude, ["mcp", "remove", "--scope", "user", "ponzu"], "win32")).toEqual({
    file: "cmd.exe",
    argv: ["/d", "/s", "/c", `""${claude}" mcp remove --scope user ponzu"`],
    verbatim: true,
  });
  // An .exe, and every other platform, runs as it is.
  const exe = "C:\\Users\\me\\.local\\bin\\claude.exe";
  expect(invocation(exe, ["mcp"], "win32")).toEqual({ file: exe, argv: ["mcp"], verbatim: false });
  expect(invocation("/opt/homebrew/bin/codex", ["mcp"], "darwin").verbatim).toBe(false);
  expect(() => invocation(claude, ["mcp", "a & calc"], "win32")).toThrow();
  expect(() => invocation("C:\\100%\\claude.cmd", ["mcp"], "win32")).toThrow();
});

test("runs once: what it did is recorded, and a later launch does nothing", async () => {
  const m = machine();
  put(m.shim, macShim(join(m.home, "Gone/Ponzu.app")));
  const record = join(m.home, "userData/legacy-cleanup.json");
  mkdirSync(dirname(record), { recursive: true });
  const first = await removeLegacyOnce(m.host, record, "2.0.0");
  expect(first?.map((s) => s.outcome)).toEqual(["removed"]);
  expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({
    version: "2.0.0",
    steps: first,
  });
  put(m.shim, macShim(join(m.home, "Gone/Ponzu.app")));
  expect(await removeLegacyOnce(m.host, record, "2.0.1")).toBeNull();
  expect(existsSync(m.shim)).toBe(true);
});

/** Every entry under `root`: its kind, mode and contents, or where a link points. */
function snapshot(root: string): Record<string, string> {
  const seen: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) seen[path] = `link ${readlinkSync(path)}`;
      else if (entry.isDirectory()) {
        seen[path] = `dir ${entry.mode}`;
        walk(path);
      } else seen[path] = `file ${entry.mode} ${readFileSync(path, "utf8")}`;
    }
  };
  walk(root);
  return seen;
}

test("Ponzu Dev and Ponzu Local never clean up after 1.x; only a release does", async () => {
  // A home 1.x left with its server gone, which a release would clean up.
  const m = machine();
  m.agents();
  const app = join(m.home, "Gone/Ponzu.app");
  put(m.shim, macShim(app));
  mkdirSync(join(m.home, ".local/bin"), { recursive: true });
  symlinkSync(m.shim, join(m.home, ".local/bin/ponzu"));
  put(
    join(m.home, ".claude.json"),
    JSON.stringify({ mcpServers: { ponzu: { type: "stdio", command: m.shim, args: ["mcp"] } } }),
  );
  m.codex({ type: "stdio", command: m.shim, args: ["mcp"] });
  put(
    join(m.home, ".cursor/mcp.json"),
    JSON.stringify({ mcpServers: { ponzu: { command: m.shim, args: ["mcp"] } } }),
  );
  put(
    join(m.home, "Library/LaunchAgents/design.ponzu.app.wake.plist"),
    wakePlist(join(app, "Contents/Resources/server/ponzu")),
  );
  put(join(m.home, ".ponzu/agents.json"), "{}");
  const support = join(m.home, "Library/Application Support");
  put(join(support, "Ponzu/Local State"), "1.x's own");
  const before = snapshot(m.home);

  for (const build of [
    configFor(true, {}, built({ variant: "dev" })),
    configFor(false, {}, built()),
  ]) {
    const record = join(support, build.appName, "legacy-cleanup.json");
    expect(await removeLegacyFor(build, m.host, record, "2.0.0")).toBeNull();
    expect(m.calls).toEqual([]);
    expect(existsSync(record)).toBe(false);
    expect(snapshot(m.home)).toEqual(before);
  }

  const release = configFor(true, {}, built());
  const record = join(support, release.appName, "legacy-cleanup.json");
  const steps = await removeLegacyFor(release, m.host, record, "2.0.0");
  expect(steps?.some((step) => step.outcome === "removed")).toBe(true);
  expect(existsSync(m.shim)).toBe(false);
  expect(existsSync(record)).toBe(true);
});
