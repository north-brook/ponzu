import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Ponzu on the local network, for the phone app: on the same Wi-Fi it finds
 * this Mac without a pairing code. The advertisement only says where to look
 * on the tailnet (the MagicDNS name); the phone connects there, never to the
 * LAN address, and this Mac answers it by Tailscale identity as it answers
 * any of the owner's devices.
 */
export interface Advert {
  /** This Mac's host name, e.g. "workstation". Also the instance name. */
  name: string;
  /** This Mac's MagicDNS name, e.g. "workstation.tail023d74.ts.net". */
  host: string;
  /** The tailnet port, 7777. */
  port: number;
}

export const SERVICE = "_ponzu._tcp";
const DNS_SD = "/usr/bin/dns-sd";

/** `dns-sd -R <name> _ponzu._tcp local <port> v=1 host=<magicdns> name=<name>`. */
export function bonjourArgs(a: Advert): string[] {
  return [
    "-R",
    a.name,
    SERVICE,
    "local",
    String(a.port),
    "v=1",
    `host=${a.host}`,
    `name=${a.name}`,
  ];
}

/**
 * dns-sd registers until it's killed. It runs under a shell that waits on its
 * stdin, a pipe from this process, so it also goes when this process dies
 * without stopping it (a crash, SIGKILL) rather than advertising a server
 * that's gone. The shell exits when dns-sd does.
 */
const WATCH = `exec 3<&0
${DNS_SD} "$@" </dev/null >/dev/null 2>&1 &
pid=$!
(read _ <&3; kill $pid 2>/dev/null) &
wait $pid`;

export interface Bonjour {
  readonly advert: Advert;
  stop(): void;
}

/**
 * Advertise `_ponzu._tcp` with macOS's own dns-sd: no native modules. Null
 * where there's no dns-sd (not macOS) or PONZU_BONJOUR=0. If dns-sd exits on
 * its own (mDNSResponder restarted, say), it's started again after a pause.
 */
export function advertise(advert: Advert): Bonjour | null {
  if (process.env.PONZU_BONJOUR === "0" || !existsSync(DNS_SD)) return null;
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const start = () => {
    try {
      const c = spawn("/bin/sh", ["-c", WATCH, "sh", ...bonjourArgs(advert)], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      child = c;
      c.on("error", () => {});
      c.stdin?.on("error", () => {});
      c.on("exit", () => {
        c.stdin?.end();
        if (stopped || child !== c) return;
        child = null;
        timer = setTimeout(start, 10_000);
        timer.unref?.();
      });
      // The pipe alone mustn't keep a server that's otherwise done from exiting.
      c.unref();
      (c.stdin as { unref?: () => void } | null)?.unref?.();
    } catch {}
  };
  start();
  return {
    advert,
    stop() {
      stopped = true;
      clearTimeout(timer);
      // Closing the pipe stops dns-sd; the shell then exits.
      child?.stdin?.end();
      child = null;
    },
  };
}
