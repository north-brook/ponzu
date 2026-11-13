/*
 * What the .dom tests share: a test's page script bundled for the browser, and the canvas's own
 * stylesheet. Neither writes into the source tree, and neither blocks the test worker.
 */
import { join } from "node:path";

/**
 * `source` bundled for the browser. The entry is in memory, at a path beside the sources so its
 * `./` imports resolve; nothing is written, so no two runs of a test ever share an entry file.
 */
export async function bundle(
  name: string,
  source: string,
  define: Record<string, string> = {},
): Promise<string> {
  const entry = join(import.meta.dir, `.${name}-entry.tsx`);
  const built = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: source },
    target: "browser",
    format: "esm",
    define,
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  return built.outputs[0]!.text();
}

/**
 * The canvas's stylesheet, as Tailwind builds it: unstyled, its plane and boards don't lay out.
 * The CLI is awaited, never run through spawnSync, which can lose a child's exit in a
 * `bun test --parallel` worker and wait on it until the hook times out (oven-sh/bun#47257).
 */
export async function canvasCss(): Promise<string> {
  const tw = Bun.spawn(
    [
      join(import.meta.dir, "../node_modules/.bin/tailwindcss"),
      "-i",
      join(import.meta.dir, "styles.css"),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [css, stderr, code] = await Promise.all([
    new Response(tw.stdout).text(),
    new Response(tw.stderr).text(),
    tw.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return css;
}
