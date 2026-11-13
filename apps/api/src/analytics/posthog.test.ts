import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { createLogger } from "../http/log.ts";
import type { AiTracing } from "./ai.ts";
import { cachedOptOuts, createAnalytics, type OptOuts } from "./analytics.ts";
import { createPosthogAnalytics, createPosthogSink } from "./posthog.ts";
import { withScope } from "./scope.ts";

// posthog-node itself, over a `fetch` that is a local PostHog: the batches exactly as PostHog
// would receive them. The "Ponzu Dev" project does not exist yet, and nothing here reaches any.

type Batch = { api_key: string; batch: Record<string, any>[] };

function localPosthog() {
  const batches: Batch[] = [];
  const fetch = async (_url: string, options: { body?: unknown }) => {
    const raw = options.body;
    const text =
      typeof raw === "string"
        ? raw
        : gunzipSync(
            new Uint8Array(raw instanceof Blob ? await raw.arrayBuffer() : (raw as Uint8Array)),
          ).toString();
    batches.push(JSON.parse(text));
    return { status: 200, text: async () => "{}", json: async () => ({}) } as never;
  };
  return { batches, events: () => batches.flatMap((b) => b.batch), fetch };
}

const noTracing: AiTracing = {
  content: false,
  call: () => ({ telemetry: {}, runtimeContext: {} }),
  flush: async () => {},
};

function connected(optOuts: OptOuts | null = null) {
  const ph = localPosthog();
  const { sink, client } = createPosthogSink(
    { key: "phc_dev", host: "https://ph.test", aiContent: false },
    { fetch: ph.fetch, ai: noTracing, optOuts },
  );
  const kept: Promise<void>[] = [];
  const analytics = createAnalytics({
    sink,
    keep: (work) => kept.push(work),
    log: createLogger(() => {}),
    optOuts,
  });
  return { ph, analytics, client, sent: () => Promise.all(kept) };
}

test("someone who turned usage sharing off never reaches PostHog's wire; others do", async () => {
  const { ph, analytics, client, sent } = connected(
    cachedOptOuts(async () => ["usr_off"], Date.now),
  );
  for (const userId of ["usr_off", "usr_on"]) {
    analytics.capture("user signed out", {}, { distinctId: userId });
    analytics.identify({
      userId,
      name: null,
      email: null,
      githubLogin: userId,
      signedUpAt: new Date(0),
    });
  }
  await sent();
  await analytics.flush();
  const people = ph.events().map((e) => e.distinct_id);
  expect(people.sort()).toEqual(["usr_on", "usr_on"]);
  expect(JSON.stringify(ph.batches)).not.toContain("usr_off");
  await client.shutdown();
});

const scope = {
  userId: () => "usr_ada",
  canvasId: () => null,
  sessionId: "0192e0a0-0000-7000-8000-000000000001",
  requestId: "req_1",
  route: () => "POST /v1/canvases",
  workspaceId: "ws_1",
};

test("an event reaches PostHog under the project token, the person, the workspace and the session", async () => {
  const { ph, analytics, client, sent } = connected();
  withScope(scope, () =>
    analytics.capture("canvas created", {
      canvas_id: "cnv_1",
      source: "idea",
      with_message: true,
      model: null,
      effort: null,
    }),
  );
  await sent();

  expect(ph.batches[0]!.api_key).toBe("phc_dev");
  const [event] = ph.events();
  expect(event).toMatchObject({
    event: "canvas created",
    distinct_id: "usr_ada",
    properties: {
      canvas_id: "cnv_1",
      source: "idea",
      workspace_id: "ws_1",
      $session_id: "0192e0a0-0000-7000-8000-000000000001",
      $groups: { workspace: "ws_1" },
      // The API's address is Vercel's: no location is taken from it.
      $geoip_disable: true,
    },
  });
  await client.shutdown();
});

test("people and workspaces get their profiles, and an exception goes to error tracking", async () => {
  const { ph, analytics, client, sent } = connected();
  analytics.identify({
    userId: "usr_ada",
    name: "Ada",
    email: "ada@example.com",
    githubLogin: "ada",
    signedUpAt: new Date("2026-11-01T00:00:00Z"),
  });
  analytics.group({
    workspaceId: "ws_1",
    name: "north-brook",
    kind: "organization",
    repos: 12,
    repositorySelection: "all",
  });
  withScope(scope, () => analytics.exception(new Error("boom"), { status: 500 }));
  // An exception is queued only once its stack is read, and posthog-node's flush waits for that:
  // the send the capture scheduled carries it, however long the read takes.
  await sent();

  const byName = new Map(ph.events().map((e) => [e.event, e]));
  expect(byName.get("$identify")).toMatchObject({
    distinct_id: "usr_ada",
    properties: {
      $set: { name: "Ada", email: "ada@example.com", github_login: "ada" },
      $set_once: { signed_up_at: "2026-11-01T00:00:00.000Z" },
    },
  });
  expect(byName.get("$groupidentify")).toMatchObject({
    properties: {
      $group_type: "workspace",
      $group_key: "ws_1",
      $group_set: { name: "north-brook", kind: "organization", repos: 12 },
    },
  });
  expect(byName.get("$exception")).toMatchObject({
    distinct_id: "usr_ada",
    properties: { route: "POST /v1/canvases", request_id: "req_1", status: 500 },
  });
  await client.shutdown();
});

test("without a key there is no client at all", () => {
  const optOuts = cachedOptOuts(async () => [], Date.now);
  expect(
    createPosthogAnalytics(null, { keep: () => {}, log: createLogger(() => {}), optOuts }),
  ).toBeNull();
});
