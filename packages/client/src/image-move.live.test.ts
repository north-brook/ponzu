import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "./api.ts";
import { createLive } from "./live/live.ts";
import { createSession } from "./session.ts";
import { sessionFile } from "./testing/session-file.ts";

/*
 * A design recreated on a new sandbox image, for real, opt in, in two runs with a deploy between
 * (docs/cloud.md, "How images roll out"). Observed through the API alone, like
 * lifecycle.live.test.ts, whose environment it takes.
 *
 * Before: a design in the test repository is asked to remember a code word and to write a line to
 * a file it does not commit; the agent goes idle and the idle stop puts the sandbox to sleep.
 * What the second run needs is written to PONZU_IMAGE_MOVE_STATE (a file in the temp folder by
 * default). Between: deploy the API with another image in apps/runner/image/current.json (or
 * restart `bun run dev` with it). After: a message wakes it, which recreates its sandbox on that
 * image; the agent must answer with the code word without a tool and find the line in the file,
 * uncommitted: the conversation and the work in progress came over from the checkpoint. Then the
 * design is deleted with its sandbox. The API captures `sandbox woke` with `recreated: true` (or
 * logs `sandbox_move_held` with why it waited).
 *
 *   PONZU_IMAGE_MOVE_LIVE=before PONZU_API_URL=… PONZU_SESSION_FILE=… WORKOS_CLIENT_ID=… \
 *   ANTHROPIC_API_KEY=… GITHUB_TEST_REPO=owner/name CRON_SECRET=… \
 *     bun test packages/client/src/image-move.live.test.ts
 *   # deploy that API with another image in current.json, then:
 *   PONZU_IMAGE_MOVE_LIVE=after … bun test packages/client/src/image-move.live.test.ts
 *
 * The API must run with a short idle window (PONZU_SANDBOX_IDLE_SECONDS=60), and the developer's
 * Claude must not be connected (the run connects the key and disconnects it at the end). It
 * spends a few cents on Haiku and a few minutes of two small sandboxes.
 */

const env = process.env;
const phase = env.PONZU_IMAGE_MOVE_LIVE;
const ready =
  (phase === "before" || phase === "after") &&
  env.PONZU_SESSION_FILE &&
  env.WORKOS_CLIENT_ID &&
  env.ANTHROPIC_API_KEY &&
  env.GITHUB_TEST_REPO &&
  env.CRON_SECRET;
const STATE = env.PONZU_IMAGE_MOVE_STATE ?? join(tmpdir(), "ponzu-image-move.json");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const WORD = `quince${Math.floor(Math.random() * 900 + 100)}`;
const FIRST = [
  `Remember the code word ${WORD}. Write the single line "moved ${WORD}" to the file`,
  "notes/move.md in the repository and do not commit it. Do not draw anything or run the dev",
  "server. Then reply done.",
].join(" ");
const SECOND_MESSAGE = [
  "Without using any tool, tell me the code word I asked you to remember. Then read",
  "notes/move.md and tell me what it says, and whether git sees it as uncommitted.",
].join(" ");

interface Item {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!ready)("a design recreated on a new image, for real", () => {
  test(
    `${phase}: the conversation and the work in progress come over to the new sandbox`,
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
      const until = async <T>(what: string, ms: number, check: () => Promise<T | undefined>) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const found = await check();
          if (found !== undefined && found !== false) return found;
          if (Date.now() > deadline) throw new Error(`Gave up waiting for ${what}.`);
          await new Promise((resolve) => setTimeout(resolve, SECOND));
        }
      };
      const thread = (designId: string) =>
        call<{ items: Item[] }>("GET", `designs/${designId}/thread`);
      const lastAnswer = async (designId: string) => {
        const items = (await thread(designId)).items.filter(
          (item) => item.kind !== "message" && item.kind !== "comment",
        );
        const last = items.at(-1);
        return last?.kind === "assistant" ? String(last.payload.text ?? "") : undefined;
      };
      const idle = (designId: string) =>
        until("the agent to be idle", 5 * MINUTE, async () => {
          const design = await call<{ agentState: string }>("GET", `designs/${designId}`);
          return design.agentState === "idle" || undefined;
        });

      if (phase === "before") {
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
        const before = await call<{ account: { kind: string } | null }>("GET", "claude");
        if (before.account) {
          throw new Error("The developer has Claude connected, which this would replace.");
        }
        await call("POST", "claude/api-key", { key: env.ANTHROPIC_API_KEY });

        const created = await call<{ id: string }>("POST", "designs", {
          ...found,
          message: { text: FIRST },
          model: "claude-haiku-5-5",
          effort: "low",
          createKey: `image-move-live-${Date.now()}`,
        });
        writeFileSync(STATE, JSON.stringify({ designId: created.id, word: WORD }));
        console.log(`design ${created.id}, code word ${WORD}, state in ${STATE}`);
        await until("the first answer", 5 * MINUTE, () => lastAnswer(created.id));
        await idle(created.id);
        const live = createLive({ api });
        try {
          await until("the idle stop", 5 * MINUTE, async () => {
            await cron();
            const row = live.snapshot("design.head", { designId: created.id }).rows?.[0];
            return row?.sandboxState === "asleep" || undefined;
          });
        } finally {
          live.close();
        }
        console.log(
          "Asleep. Now deploy the API with another image in current.json, and run the after phase.",
        );
        return;
      }

      const { designId, word } = JSON.parse(readFileSync(STATE, "utf8")) as {
        designId: string;
        word: string;
      };
      try {
        const asked = Date.now();
        await call("POST", `designs/${designId}/messages`, { text: SECOND_MESSAGE });
        const answer = await until("the answer on the new sandbox", 8 * MINUTE, async () => {
          const text = await lastAnswer(designId);
          return text && text.includes(word) && /moved/i.test(text) ? text : undefined;
        });
        console.log(`answered in ${(Date.now() - asked) / 1000} s: ${answer}`);
        // The conversation came over (the word, with no tool) and so did the uncommitted file.
        expect(answer).toContain(word);
        expect(answer).toContain(`moved ${word}`);
        expect(answer.toLowerCase()).toMatch(/uncommitted|untracked|not committed/);
      } finally {
        await call("DELETE", `designs/${designId}`);
        await call("DELETE", "claude");
        console.log("Design deleted. Its `sandbox woke` should say recreated: true.");
      }
    },
    20 * MINUTE,
  );
});
