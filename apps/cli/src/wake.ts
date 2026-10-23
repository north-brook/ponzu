import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { fstatSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isTailnetAddress, ownerOf, readTailnet } from "@ponzu/server";
import { findApp, ownBundle, runningHost, startApp } from "./host.ts";

/**
 * The wake helper: the phone app knocks on this Mac's port 7778 when Ponzu
 * isn't answering on 7777, and Ponzu starts in the background.
 *
 * A launchd LaunchAgent holds the socket, so nothing of Ponzu's runs until a
 * knock. launchd binds every interface rather than the tailnet address: it
 * binds once, when the agent loads at login, often before Tailscale is up,
 * and never again, and Tailscale's address can change when a device is
 * re-added. Instead, launchd starts `ponzu wake` per connection (inetd
 * style, the socket on stdin and stdout), and it answers only this Mac and
 * the owner's own devices on the tailnet, as Tailscale vouches for them.
 *
 * Why that's safe: a knock carries nothing. `ponzu wake` reads and discards
 * the request, answers with a status line, and at most starts Ponzu with
 * `--background`, which is what any agent on this Mac can already do. Ponzu
 * itself authorizes every request it serves by Tailscale identity, and quits
 * again after 15 idle minutes.
 */
export const WAKE_LABEL = "design.ponzu.app.wake";
export const WAKE_PORT = 7778;

/** ~/Library/LaunchAgents. PONZU_LAUNCH_AGENTS moves it, for tests. */
const agentsDir = () => process.env.PONZU_LAUNCH_AGENTS ?? join(homedir(), "Library/LaunchAgents");
export const wakePlistPath = () => join(agentsDir(), `${WAKE_LABEL}.plist`);

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The LaunchAgent: `<program> wake` per connection to TCP `port`, on every
 * interface, IPv4 and IPv6.
 */
export function wakePlist(program: string, port = WAKE_PORT): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WAKE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program)}</string>
    <string>wake</string>
  </array>
  <key>inetdCompatibility</key>
  <dict>
    <key>Wait</key>
    <false/>
  </dict>
  <key>Sockets</key>
  <dict>
    <key>Listeners</key>
    <dict>
      <key>SockServiceName</key>
      <string>${port}</string>
      <key>SockType</key>
      <string>stream</string>
    </dict>
  </dict>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

/** Runs launchctl; true when it exits 0. */
export type Launchctl = (args: string[]) => boolean;

const launchctl: Launchctl = (args) =>
  spawnSync("/bin/launchctl", args, { stdio: "ignore" }).status === 0;

const domain = () => `gui/${process.getuid?.() ?? 501}`;

/**
 * Install the wake helper for `program` (the server inside the installed
 * Ponzu.app), or bring it up to date. Nothing to do when the plist already
 * says the same and launchd has it loaded, so the app can call this on every
 * launch. Returns whether it changed anything.
 */
export async function installWake(program: string, run: Launchctl = launchctl): Promise<boolean> {
  const path = wakePlistPath();
  const plist = wakePlist(program);
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (current === plist && run(["print", `${domain()}/${WAKE_LABEL}`])) return false;
  await mkdir(agentsDir(), { recursive: true });
  await writeFile(path, plist);
  run(["bootout", `${domain()}/${WAKE_LABEL}`]);
  run(["bootstrap", domain(), path]);
  return true;
}

export async function uninstallWake(run: Launchctl = launchctl): Promise<void> {
  run(["bootout", `${domain()}/${WAKE_LABEL}`]);
  await rm(wakePlistPath(), { force: true });
}

/** Who knocked: this Mac, a tailnet address, or anywhere else. */
export type Peer = { kind: "local" } | { kind: "tailnet"; ip: string } | { kind: "other" };

export function peerKind(ip: string | null): Peer {
  if (ip === null) return { kind: "local" };
  const bare = ip.replace(/^::ffff:/, "");
  if (bare === "127.0.0.1" || bare === "::1") return { kind: "local" };
  if (isTailnetAddress(bare)) return { kind: "tailnet", ip: bare };
  return { kind: "other" };
}

export interface WakeDeps {
  /** The announced Ponzu, if it answers. */
  running(): Promise<string | null>;
  /** The installed Ponzu.app. */
  app(): string | null;
  start(app: string): Promise<void>;
  /** Whether a tailnet address is one of this Mac's owner's own devices. */
  trusted(ip: string): Promise<boolean>;
}

export type WakeResult = "refused" | "running" | "waking" | "not installed";

/** The knock: refuse strangers, leave a running Ponzu be, otherwise start it. */
export async function wake(peer: Peer, deps: WakeDeps): Promise<WakeResult> {
  if (peer.kind === "other") return "refused";
  if (peer.kind === "tailnet" && !(await deps.trusted(peer.ip))) return "refused";
  if (await deps.running()) return "running";
  const app = deps.app();
  if (!app) return "not installed";
  await deps.start(app);
  return "waking";
}

const STATUS: Record<WakeResult, string> = {
  refused: "403 Forbidden",
  running: "200 OK",
  waking: "202 Accepted",
  "not installed": "404 Not Found",
};

/** What the phone reads: a status line, and a word for it in the body. */
export function wakeResponse(result: WakeResult): string {
  const body = result === "refused" ? "" : JSON.stringify({ ponzu: result });
  return [
    `HTTP/1.1 ${STATUS[result]}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}

/**
 * `ponzu wake`: one knock, as launchd hands it over. Run by hand (stdin isn't a
 * socket), it's this Mac asking.
 */
export async function runWake(): Promise<void> {
  const peer = peerKind(socketPeer());
  const request = discardRequest();
  const result = await wake(peer, {
    running: runningHost,
    app: findApp,
    start: startApp,
    trusted: async (ip) => {
      const self = await readTailnet().catch(() => null);
      return Boolean(self && (await ownerOf(ip)) === self.user);
    },
  });
  await request;
  await new Promise<void>((resolve) => process.stdout.write(wakeResponse(result), () => resolve()));
  if (!isSocket()) console.error(`\nPonzu: ${result}`);
  process.exit(0);
}

/** `ponzu wake install` and `ponzu wake uninstall`. */
export async function wakeCommand(arg?: string): Promise<void> {
  if (!arg) return runWake();
  if (arg === "uninstall") {
    await uninstallWake();
    return console.log(
      "Removed the wake helper. The iPhone app can't start Ponzu on this Mac now.",
    );
  }
  if (arg === "install") {
    // Only for the installed app: launchd keeps this path, and a disk image's goes away.
    if (process.platform !== "darwin" || !ownBundle()) {
      console.error("The wake helper installs from the Ponzu app in Applications.");
      process.exit(1);
    }
    const changed = await installWake(process.execPath);
    return console.log(changed ? "Installed the wake helper." : "The wake helper is up to date.");
  }
  console.error("Usage: ponzu wake [install|uninstall]");
  process.exit(1);
}

function isSocket(): boolean {
  try {
    return fstatSync(0).isSocket();
  } catch {
    return false;
  }
}

/** Read the knock's request, up to a second or 8 KB, and drop it. */
async function discardRequest(): Promise<void> {
  if (!isSocket()) return;
  const reader = Bun.stdin.stream().getReader();
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), 1000);
  try {
    let seen = "";
    while (seen.length < 8192 && !seen.includes("\r\n\r\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
  } catch {}
  clearTimeout(timer);
}

/**
 * The address on the other end of stdin, when launchd made it a socket. Null
 * when it isn't one. getpeername through bun:ffi, or lsof if that fails;
 * "unknown" (refused) when neither can say.
 */
function socketPeer(): string | null {
  if (!isSocket()) return null;
  return getpeername() ?? lsofPeer() ?? "unknown";
}

function getpeername(): string | null {
  try {
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      getpeername: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    const addr = new Uint8Array(128);
    const len = new Uint32Array([128]);
    const rc = lib.symbols.getpeername(0, ptr(addr), ptr(len));
    lib.close();
    return rc === 0 ? sockaddrIp(addr) : null;
  } catch {
    return null;
  }
}

/** A BSD sockaddr's address: sockaddr_in (AF_INET, 2) or sockaddr_in6 (AF_INET6, 30). */
export function sockaddrIp(addr: Uint8Array): string | null {
  if (addr[1] === 2) return Array.from(addr.slice(4, 8)).join(".");
  if (addr[1] === 30) {
    const groups: string[] = [];
    for (let i = 8; i < 24; i += 2) groups.push(((addr[i]! << 8) | addr[i + 1]!).toString(16));
    const ip = groups.join(":");
    // An IPv4 client on the dual-stack listener.
    const mapped = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(ip);
    if (mapped) {
      const [hi, lo] = [Number.parseInt(mapped[1]!, 16), Number.parseInt(mapped[2]!, 16)];
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    return ip === "0:0:0:0:0:0:0:1" ? "::1" : ip;
  }
  return null;
}

/** `n100.64.0.1:7778->100.64.0.2:51234`: the part after the arrow, without the port. */
function lsofPeer(): string | null {
  const out = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(process.pid), "-d", "0", "-Fn"],
    {
      encoding: "utf8",
    },
  ).stdout;
  const remote = /->(.+):\d+$/m.exec(out ?? "")?.[1];
  return remote ? remote.replace(/^\[|\]$/g, "") : null;
}
