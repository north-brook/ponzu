import { describe, expect, test } from "bun:test";
import { createApi } from "./api.ts";
import { createLive } from "./live/live.ts";
import { createSession } from "./session.ts";
import { sessionFile } from "./testing/session-file.ts";

/*
 * A design's whole life on the real services, opt in, observed through the API alone: a design
 * made with its first message in the test repository's workspace, its sandbox made from the
 * baked image on boat.dev, Claude Code drawing an artboard on the developer's Anthropic key,
 * the agent going idle, the idle stop putting the sandbox to sleep, a second message waking it
 * and being answered in the same Claude session, and the design deleted with its sandbox.
 * It spends real money (a few cents on Haiku, a few minutes of a small sandbox).
 *
 *   PONZU_LIFECYCLE_LIVE=1 PONZU_API_URL=… PONZU_SESSION_FILE=… WORKOS_CLIENT_ID=… \
 *   ANTHROPIC_API_KEY=… GITHUB_TEST_REPO=owner/name CRON_SECRET=… \
 *     bun test packages/client/src/lifecycle.live.test.ts
 *
 * The API it talks to must be one the sandbox can reach, run with a short idle window
 * (PONZU_SANDBOX_IDLE_SECONDS=60) so that the stop comes within the test; it calls the
 * minute's cron itself, as Vercel would. PONZU_LIFECYCLE_COLD=1 also waits out the warm window
 * for a cold wake. Run one live test with the session file at a time.
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

describe.skipIf(!ready)("a design's sandbox, for real", () => {
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
      const created = await call<{ id: string; branch: string }>("POST", "designs", {
        ...found,
        message: { text: FIRST },
        model: "claude-haiku-5-5",
        effort: "low",
        createKey: `lifecycle-live-${Date.now()}`,
      });
      mark("design created with its first message");
      const designId = created.id;
      expect(created.branch).toMatch(/^pz\//);
      const sandboxState = () =>
        live.snapshot("design.head", { designId }).rows?.[0]?.sandboxState ?? null;
      const stop = live.subscribe("design.head", { designId }, (snapshot) => {
        const row = snapshot.rows?.[0];
        if (row?.agentState === "waking") mark("head says waking");
        if (row?.sandboxState === "awake") mark("sandbox awake");
        if (row?.agentState === "working") mark("agent working");
      });

      try {
        const thread = () => call<{ items: Item[] }>("GET", `designs/${designId}/thread`);
        const fromRunner = (items: Item[]) =>
          items.filter((item) => item.kind !== "message" && item.kind !== "comment");
        await until("the runner's first thread item", 5 * MINUTE, async () =>
          fromRunner((await thread()).items).length > 0 ? true : undefined,
        );
        mark("first thread item from the runner");

        await until("an artboard by the agent", 5 * MINUTE, async () => {
          const { doc } = await call<{ doc: { pages: { artboards: unknown[] }[] } }>(
            "GET",
            `designs/${designId}/doc`,
          );
          return doc.pages.some((page) => page.artboards.length > 0) || undefined;
        });
        mark("first artboard committed");
        const { ops } = await call<{ ops: { actor: { kind: string } }[] }>(
          "GET",
          `designs/${designId}/ops?after=0`,
        );
        expect(ops.some((op) => op.actor.kind === "agent")).toBe(true);

        await until("the agent to be idle", 5 * MINUTE, async () => {
          const design = await call<{ agentState: string }>("GET", `designs/${designId}`);
          return design.agentState === "idle" || undefined;
        });
        mark("agent idle");

        // The idle stop: the cron, as Vercel runs it, after the short idle window.
        await until("the idle stop", 5 * MINUTE, async () => {
          await cron();
          return sandboxState() === "asleep" || undefined;
        });
        mark("sandbox asleep after the idle window");

        const asked = at();
        await call("POST", `designs/${designId}/messages`, {
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
        marks["warm wake to answer"] = at() - asked;
        console.log(`answered in the same session: ${answered}`);

        if (env.PONZU_LIFECYCLE_COLD === "1") {
          await until("the idle stop again", 5 * MINUTE, async () => {
            await cron();
            return sandboxState() === "asleep" || undefined;
          });
          // A stop keeps the machine about ten minutes; after that a wake is a boot.
          await new Promise((resolve) => setTimeout(resolve, 11 * MINUTE));
          const coldAsked = at();
          await call("POST", `designs/${designId}/messages`, { text: "Reply with the word ok." });
          await until("the sandbox to wake cold", 3 * MINUTE, async () =>
            sandboxState() === "awake" ? true : undefined,
          );
          marks["cold wake to awake"] = at() - coldAsked;
          await until("the cold answer", 5 * MINUTE, async () => {
            const last = fromRunner((await thread()).items).at(-1);
            return last?.kind === "assistant" && /ok/i.test(String(last.payload.text))
              ? true
              : undefined;
          });
          marks["cold wake to answer"] = at() - coldAsked;
        }
      } finally {
        stop();
        live.close();
        await call("DELETE", `designs/${designId}`);
        mark("design deleted");
        // Leave the developer's Claude as it was found: not connected.
        await call("DELETE", "claude");
        console.log(JSON.stringify(marks, null, 2));
      }
    },
    40 * MINUTE,
  );
});
