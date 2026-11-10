import { afterAll, describe, expect, test } from "bun:test";
import { createRealtimeClient, type SealedLiveQuery } from "@neon/realtime/client";
import { createDb, upsertMembership, upsertWorkspace } from "@ponzu/db";
import { createRealtimeSealer } from "../deps/realtime.ts";
import { call } from "../testing/designs.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

/*
 * The real thing, opt in: the API on the Neon `dev` branch and its Realtime, with GitHub and
 * WorkOS still in memory. It seals a query, subscribes to it as a client would, commits an op
 * through the API and waits for the change to arrive. Skipped unless all three are set:
 *
 *   DATABASE_URL=<dev's pooled URL> NEON_REALTIME_URL=… NEON_REALTIME_SECRET=… \
 *     bun test apps/api/src/live/realtime.live.test.ts
 *
 * It writes a person, a workspace and a design to that database, and deletes the design.
 */

const {
  DATABASE_URL: url,
  NEON_REALTIME_URL: realtimeUrl,
  NEON_REALTIME_SECRET: secret,
} = process.env;
const ready = Boolean(url && realtimeUrl && secret);

describe.skipIf(!ready)("Realtime on the dev branch", () => {
  let t: TestApp | undefined;
  afterAll(() => t?.close());

  test("a design's head moves on a subscriber's screen when an op is committed", async () => {
    const db = createDb(url!);
    const realtime = createRealtimeSealer({
      url: realtimeUrl!,
      secret: secret!,
      database: new URL(url!).pathname.slice(1),
    });
    t = await createTestApp({ live: { db, realtime } });
    const person = await t.signInAs({ login: "realtime-check" });
    // A fixed account, so running this again reuses its workspace instead of adding one.
    const workspace = await upsertWorkspace(db, {
      githubAccountId: 9_100_000_001,
      githubLogin: "ponzu-realtime-check",
      kind: "org",
      name: "Realtime check",
      avatarUrl: null,
      installationId: 9_100_000_002,
      repositorySelection: "selected",
      installedByUserId: null,
    });
    await upsertMembership(db, { workspaceId: workspace.id, userId: person.userId, role: "admin" });
    const created = await call(t, person.headers, "POST", "/v1/designs", {
      workspaceId: workspace.id,
      name: "Realtime check",
    });
    const designId: string = created.body.id;

    const client = createRealtimeClient({ url: realtimeUrl! });
    try {
      const live = await call(t, person.headers, "POST", "/v1/live", {
        queries: [{ name: "design.head", args: { designId } }],
      });
      expect(live.body.url).toBe(realtimeUrl);
      const sealed = live.body.results[0].sealed as SealedLiveQuery<{ seq: string }>;
      const subscription = client.subscribe(sealed);
      const seq = () => Number(subscription.getSnapshot().data?.[0]?.seq ?? -1);
      const until = (done: () => boolean, ms: number) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no change within ${ms} ms`)), ms);
          const check = () => {
            if (subscription.getState().status === "error") {
              clearTimeout(timer);
              reject(new Error(String(subscription.getState().error?.message)));
            } else if (done()) {
              clearTimeout(timer);
              resolve();
            }
          };
          subscription.onChange(check);
          check();
        });
      const subscribing = performance.now();
      await until(() => seq() === 0, 15_000);
      const firstResult = performance.now() - subscribing;

      // Renaming the first page: something a person may commit.
      const document = await call(t, person.headers, "GET", `/v1/designs/${designId}/doc`);
      const page: string = document.body.doc.pages[0].id;
      const sent = performance.now();
      const commit = await call(t, person.headers, "POST", `/v1/designs/${designId}/ops`, {
        ops: [{ id: "op_live_rename", op: { op: "page.update", id: page, name: "Renamed" } }],
      });
      const answered = performance.now();
      expect(commit.body.seq).toBe(1);
      await until(() => seq() === 1, 15_000);
      const arrived = performance.now();
      console.log(
        `Realtime on dev: first result in ${firstResult.toFixed(0)} ms; the commit answered in ` +
          `${(answered - sent).toFixed(0)} ms; the new seq arrived ${(arrived - answered).toFixed(0)} ms ` +
          `after that, ${(arrived - sent).toFixed(0)} ms after sending.`,
      );
      subscription.unsubscribe();
    } finally {
      client.close();
      await call(t, person.headers, "DELETE", `/v1/designs/${designId}`);
    }
  }, 60_000);
});
