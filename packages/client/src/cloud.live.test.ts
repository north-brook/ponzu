import { describe, expect, test } from "bun:test";
import { createApi } from "./api.ts";
import { CloudSource } from "./canvas/cloud-source.ts";
import { createLive } from "./live/live.ts";
import { createSession } from "./session.ts";
import { sessionFile } from "./testing/session-file.ts";

/*
 * The real thing, opt in: Ponzu Cloud at PONZU_API_URL (https://api.ponzu.design unless set),
 * signed in as the developer whose session `bun run dev:signin` saved (apps/api/scripts). It
 * makes a Scratch design, opens it twice as two devices would, edits it on one and waits for
 * the edit to reach the other through Neon Realtime, then deletes it.
 *
 *   PONZU_SESSION_FILE=… WORKOS_CLIENT_ID=… bun test packages/client/src/cloud.live.test.ts
 *
 * The access token lasts five minutes, so this refreshes it through the session's own code
 * and writes the rotated pair back to the file, whole or not at all: a refresh token works
 * once, and losing the new one would sign every later run out.
 */

const { PONZU_SESSION_FILE: file, WORKOS_CLIENT_ID: workosClientId } = process.env;

const until = async (done: () => boolean, ms: number, what: string) => {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Gave up waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe.skipIf(!file || !workosClientId)("Ponzu Cloud, for real", () => {
  test("an edit on one device reaches another through Realtime", async () => {
    const apiUrl = process.env.PONZU_API_URL ?? "https://api.ponzu.design";
    const session = createSession({
      apiUrl,
      workosClientId: workosClientId!,
      storage: sessionFile(file!),
      client: { platform: "macos", version: "2.0.0" },
    });
    const api = createApi(session);
    const me = await api.me();
    const workspace = me.workspaces[0];
    if (!workspace) throw new Error("The developer is in no workspace: run the setup first.");
    const actor = {
      kind: "user" as const,
      id: me.user.id,
      name: me.user.name ?? me.user.githubLogin,
    };

    const design = await api.designs.create({
      workspaceId: workspace.id,
      name: "Client live check",
    });
    // Two devices: each its own sockets and its own replica.
    const lives = [createLive({ api }), createLive({ api })];
    const [a, b] = lives.map(
      (live) => new CloudSource({ api, live, designId: design.id, me: actor }),
    );
    try {
      await until(
        () => a!.getState().status === "ready" && b!.getState().status === "ready",
        20_000,
        "both to open",
      );
      // B hears of A's edits only from its design.head subscription: wait for that to be live.
      await until(
        () => lives[1]!.snapshot("design.head", { designId: design.id }).status === "live",
        20_000,
        "the head to be live",
      );
      const page = a!.getState().doc!.pages[0]!.id;
      const samples: number[] = [];
      for (const name of ["One", "Two", "Three", "Four", "Five"]) {
        const sent = performance.now();
        a!.apply({ op: "page.update", id: page, name });
        await until(() => b!.getState().doc?.pages[0]?.name === name, 20_000, `"${name}" on B`);
        samples.push(performance.now() - sent);
      }
      samples.sort((x, y) => x - y);
      console.info(
        `edit on A to B's screen, through the API and Realtime: median ${Math.round(samples[2]!)} ms, ` +
          `min ${Math.round(samples[0]!)} ms, max ${Math.round(samples[4]!)} ms`,
      );
      expect(b!.getState().doc?.pages[0]?.name).toBe("Five");
    } finally {
      a?.close();
      b?.close();
      for (const live of lives) live.close();
      await api.designs.delete(design.id);
    }
  }, 90_000);
});
