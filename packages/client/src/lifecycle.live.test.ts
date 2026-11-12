import { describe, expect, test } from "bun:test";
import { createApi } from "./api.ts";
import { createLive } from "./live/live.ts";
import { createSession } from "./session.ts";
import { sessionFile } from "./testing/session-file.ts";

/*
 * A canvas's whole life on the real services, opt in, observed through the API alone: a canvas
 * made with its first message in the test repository's workspace, its Vercel sandbox created
 * from current.json's image, Claude Code drawing an artboard on the developer's Anthropic key,
 * the agent going idle, the idle stop putting the sandbox to sleep (ponzu-stop, then Vercel's
 * stop and snapshot), a second message resuming it from its snapshot and being answered in the
 * same Claude session, and the canvas deleted with its sandbox. It spends real money (a few
 * cents on Haiku, a few minutes of a 2 vCPU sandbox).
 *
 *   PONZU_LIFECYCLE_LIVE=1 PONZU_API_URL=… PONZU_SESSION_FILE=… WORKOS_CLIENT_ID=… \
 *   ANTHROPIC_API_KEY=… GITHUB_TEST_REPO=owner/name CRON_SECRET=… \
 *     bun test packages/client/src/lifecycle.live.test.ts
 *
 * The API it talks to must be one the sandbox can reach, run with a short idle window
 * (PONZU_SANDBOX_IDLE_SECONDS=60) so that the stop comes within the test; it calls the
 * minute's cron itself, as Vercel would. PONZU_LIFECYCLE_TWICE=1 also sleeps and resumes it a
 * second time. Every wake on Vercel boots from the snapshot, so there is no warm or cold to tell
 * apart. Run one live test with the session file at a time.
 */

const env = process.env;
const ready =
  env.PONZU_LIFECYCLE_LIVE === "1" &&
  env.PONZU_SESSION_FILE &&
  env.WORKOS_CLIENT_ID &&
  env.ANTHROPIC_API_KEY &&
  env.GITHUB_TEST_REPO &&
  env.CRON_SECRET;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const FIRST = [
  "Make one small artboard named Hello, 320 by 200, with a single centered heading that reads",
  "'Hello from Ponzu'. Do not change the repository's files or run its dev server. Then reply done.",
].join(" ");

interface Item {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!ready)("a canvas's sandbox, for real", () => {
  test(
    "wakes on its first message, draws, sleeps when idle, wakes again in the same session, and goes",
    async () => {
      const apiUrl = env.PONZU_API_URL ?? "https://api.ponzu.design";
      const session = createSession({
        apiUrl,
        workosClientId: env.WORKOS_CLIENT_ID!,
        storage: sessionFile(env.PONZU_SESSION_FILE!),
        client: { platform: "macos", version: "2.0.0" },
      });
      const api = createApi(session);
      const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const response = await session.fetch(`${apiUrl}/v1/${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
        return (text ? JSON.parse(text) : null) as T;
      };
      const cron = () =>
        fetch(`${apiUrl}/v1/cron/minute`, {
          headers: { authorization: `Bearer ${env.CRON_SECRET}` },
        }).then((response) => response.json());

      const began = performance.now();
      const at = () => Math.round(performance.now() - began) / 1000;
      const marks: Record<string, number> = {};
      const mark = (name: string) => {
        if (marks[name] !== undefined) return;
        marks[name] = at();
        console.log(`${marks[name]!.toFixed(1)} s  ${name}`);
      };
      const until = async <T>(what: string, ms: number, check: () => Promise<T | undefined>) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const found = await check();
          if (found !== undefined && found !== false) return found;
          if (Date.now() > deadline) throw new Error(`Gave up waiting for ${what}.`);
          await new Promise((resolve) => setTimeout(resolve, SECOND));
        }
      };

      // Where: the test repository's workspace.
      const me = await api.me();
      let found: { workspaceId: string; repoId: string } | undefined;
      for (const workspace of me.workspaces) {
        const { repos } = await call<{ repos: { id: string; fullName: string }[] }>(
          "GET",
          `workspaces/${workspace.id}`,
        );
        const repo = repos.find((r) => r.fullName === env.GITHUB_TEST_REPO);
        if (repo) found = { workspaceId: workspace.id, repoId: repo.id };
      }
      if (!found) throw new Error(`No workspace reaches ${env.GITHUB_TEST_REPO}.`);

      // Whose Claude: the developer's Anthropic key, through the route people use.
      const before = await call<{ account: { kind: string } | null }>("GET", "claude");
      if (before.account) {
        throw new Error(
          "The developer has Claude connected, which this would replace. Disconnect it first.",
        );
      }
      await call("POST", "claude/api-key", { key: env.ANTHROPIC_API_KEY });

      const live = createLive({ api });
      const created = await call<{ id: string; branch: string }>("POST", "canvases", {
        ...found,
        message: { text: FIRST },
        model: "claude-haiku-5-5",
        effort: "low",
        createKey: `lifecycle-live-${Date.now()}`,
      });
      mark("canvas created with its first message");
      const canvasId = created.id;
      expect(created.branch).toMatch(/^pz\//);
      const sandboxState = () =>
        live.snapshot("canvas.head", { canvasId }).rows?.[0]?.sandboxState ?? null;
      const stop = live.subscribe("canvas.head", { canvasId }, (snapshot) => {
        const row = snapshot.rows?.[0];
        if (row?.agentState === "waking") mark("head says waking");
        if (row?.sandboxState === "awake") mark("sandbox awake");
        if (row?.agentState === "working") mark("agent working");
      });

      try {
        const thread = () => call<{ items: Item[] }>("GET", `canvases/${canvasId}/thread`);
        const fromRunner = (items: Item[]) =>
          items.filter((item) => item.kind !== "message" && item.kind !== "comment");
        await until("the runner's first thread item", 5 * MINUTE, async () =>
          fromRunner((await thread()).items).length > 0 ? true : undefined,
        );
        mark("first thread item from the runner");

        await until("an artboard by the agent", 5 * MINUTE, async () => {
          const { doc } = await call<{ doc: { pages: { artboards: unknown[] }[] } }>(
            "GET",
            `canvases/${canvasId}/doc`,
          );
          return doc.pages.some((page) => page.artboards.length > 0) || undefined;
        });
        mark("first artboard committed");
        const { ops } = await call<{ ops: { actor: { kind: string } }[] }>(
          "GET",
          `canvases/${canvasId}/ops?after=0`,
        );
        expect(ops.some((op) => op.actor.kind === "agent")).toBe(true);

        await until("the agent to be idle", 5 * MINUTE, async () => {
          const canvas = await call<{ agentState: string }>("GET", `canvases/${canvasId}`);
          return canvas.agentState === "idle" || undefined;
        });
        mark("agent idle");

        // The idle stop: the cron, as Vercel runs it, after the short idle window.
        await until("the idle stop", 5 * MINUTE, async () => {
          await cron();
          return sandboxState() === "asleep" || undefined;
        });
        mark("sandbox asleep after the idle window");

        const asked = at();
        await call("POST", `canvases/${canvasId}/messages`, {
          text: "Repeat the first sentence of my first message to you, word for word, and nothing else.",
        });
        const answered = await until("the answer to the second message", 5 * MINUTE, async () => {
          const items = fromRunner((await thread()).items);
          const last = items.at(-1);
          const text = String(last?.payload.text ?? "");
          return last?.kind === "assistant" && /artboard named Hello/i.test(text)
            ? text
            : undefined;
        });
        marks["wake to answer"] = at() - asked;
        console.log(`answered in the same session: ${answered}`);

        if (env.PONZU_LIFECYCLE_TWICE === "1") {
          await until("the idle stop again", 5 * MINUTE, async () => {
            await cron();
            return sandboxState() === "asleep" || undefined;
          });
          const againAsked = at();
          await call("POST", `canvases/${canvasId}/messages`, { text: "Reply with the word ok." });
          await until("the sandbox to wake again", 3 * MINUTE, async () =>
            sandboxState() === "awake" ? true : undefined,
          );
          marks["second wake to awake"] = at() - againAsked;
          await until("the second answer", 5 * MINUTE, async () => {
            const last = fromRunner((await thread()).items).at(-1);
            return last?.kind === "assistant" && /ok/i.test(String(last.payload.text))
              ? true
              : undefined;
          });
          marks["second wake to answer"] = at() - againAsked;
        }
      } finally {
        stop();
        live.close();
        await call("DELETE", `canvases/${canvasId}`);
        mark("canvas deleted");
        // Leave the developer's Claude as it was found: not connected.
        await call("DELETE", "claude");
        console.log(JSON.stringify(marks, null, 2));
      }
    },
    40 * MINUTE,
  );
});
