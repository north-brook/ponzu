/*
 * One screenshot of a small artboard in the image's Chromium with its sandbox on, as the runner
 * takes them: `bun screenshot.js <out.png>`, with PONZU_CHROMIUM set. While it draws, it looks
 * at Chromium's processes: a sandboxed renderer runs under seccomp in a PID namespace of its
 * own. It prints what it found as JSON, and fails unless a renderer was sandboxed.
 */
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { parseArtboardFile } from "@ponzu/core";
import { ChromiumRenderer } from "@ponzu/render/chromium";

const out = process.argv[2] ?? "shot.png";
const executablePath = process.env.PONZU_CHROMIUM;
if (!executablePath) throw new Error("PONZU_CHROMIUM is not set");

const { artboard } = parseArtboardFile(
  `<section data-artboard data-id="ab_check" style="width:320px;height:160px;background:#fff8e7;padding:24px;font-family:system-ui">
<h1 data-id="n_title" style="margin:0;font-size:28px">Ponzu 🍋</h1>
<p data-id="n_body" style="font-family:Helvetica, Arial, sans-serif">設定 · 설정 · Settings</p>
</section>`,
  { id: "ab_check", name: "Check" },
);

/** Renderer processes seen, by pid: whether each was under seccomp in its own PID namespace. */
const renderers = new Map<string, boolean>();
const unsandboxed = new Set<string>();
function look(): void {
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      // Chromium starts its children through /proc/self/exe, so argv[0] does not say what they are.
      if (readlinkSync(`/proc/${pid}/exe`) !== executablePath) continue;
      // A child rewrites its own command line into one string, spaces and all.
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      if (/(^| )--no-sandbox( |$)/.test(cmdline)) unsandboxed.add(pid);
      if (!/(^| )--type=renderer( |$)/.test(cmdline)) continue;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const seccomp = /^Seccomp:\s*2$/m.test(status);
      const namespaced = (/^NSpid:(.*)$/m.exec(status)?.[1]?.trim().split(/\s+/).length ?? 1) > 1;
      renderers.set(pid, seccomp && namespaced);
    } catch {
      // Gone between the listing and the read.
    }
  }
}

const renderer = new ChromiumRenderer({ executablePath, sandbox: true, loopback: true });
const watching = setInterval(look, 20);
try {
  const shot = await renderer.render({ artboard, tokens: "", scale: 2, lint: true });
  look();
  writeFileSync(out, shot.bytes);
  const sandboxed = [...renderers.values()].filter(Boolean).length;
  console.log(
    JSON.stringify({
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes.length,
      renderers: renderers.size,
      sandboxed,
      unsandboxed: unsandboxed.size,
      issues: shot.issues.map((i) => i.kind),
    }),
  );
  if (!sandboxed || sandboxed !== renderers.size || unsandboxed.size) process.exitCode = 1;
} finally {
  clearInterval(watching);
  await renderer.close();
}
