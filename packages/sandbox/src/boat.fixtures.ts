/*
 * boat.dev's answers, for tests. The shapes were recorded from the live API on 2026-11-10 with
 * every field boat sent; ids, addresses and tokens are made up. The two marked "documented"
 * could not be provoked cheaply and follow boat's documentation instead.
 */

export const ID = "bx_b8ayy3aw";
export const TOKEN = "5f".repeat(32);
export const ORIGIN = "https://box-node-0123456789abcdef-4500.on.boat.dev";

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=utf-8",
      ratelimit: '"ip";r=9990;t=60',
      "ratelimit-policy": '"ip";q=10000;w=60',
      ...headers,
    },
  });
}

/** A sandbox as `GET /sandboxes/{id}` returns it while awake. */
export function boatSandbox(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    name: "design-d1",
    state: "ready",
    error: null,
    dataExpiredAt: null,
    stoppedAt: null,
    labels: { design: "d1" },
    health: "ok",
    healthReason: null,
    degradedSince: null,
    hydrated: true,
    hydratedAt: null,
    hydration: null,
    type: "small",
    vcpu: 2,
    memoryGB: 4,
    billingMultiplier: 0.5,
    machineProvider: "baremetal",
    url: "https://box-node-0123456789abcdef.on.boat.dev",
    ip: "203.0.113.10",
    sshEndpoint: "203.0.113.10:22001",
    createdAt: "2026-11-10T16:18:29.347Z",
    updatedAt: "2026-11-10T16:18:29.997Z",
    archiveAfter: "2026-11-10T16:33:29.412Z",
    ttlSeconds: 900,
    desktopAvailable: true,
    desktopUrl: null,
    snapshots: true,
    monitoring: true,
    snapshotAvailable: false,
    snapshotCompletedAt: null,
    snapshotVerifiedAt: null,
    lastSnapshotAttemptAt: null,
    lastSnapshotStatus: null,
    lastReboot: null,
    subdomain: "box-node-0123456789abcdef",
    team: { id: "team_00000000-0000-4000-8000-000000000000", name: "Ponzu" },
    createdBy: "Ponzu",
    createdById: "user_0000",
    access: "owner",
    holdsCreatorLogins: false,
    visibility: "shared",
    wipePendingUntilRestart: false,
    setupStatus: null,
    setupError: null,
    environment: "base",
    environmentVersion: 1,
    stop: null,
    ...overrides,
  };
}

const completedStop = {
  id: "stop_92d0d14cf831adf9",
  status: "completed",
  requestedAt: null,
  lastAttemptAt: "2026-11-10T16:18:53.696Z",
  error: null,
  endedAt: "2026-11-10T16:18:53.696Z",
  forced: false,
};

/** Asleep: boat drops the machine's addresses and keeps the stop it was put to sleep by. */
export function asleepSandbox(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return boatSandbox({
    state: "archived",
    stoppedAt: "2026-11-10T16:18:53.602Z",
    url: null,
    ip: null,
    sshEndpoint: null,
    archiveAfter: null,
    snapshotAvailable: true,
    snapshotCompletedAt: "2026-11-10T16:18:45.440Z",
    stop: completedStop,
    ...overrides,
  });
}

const START_LIMIT_HEADERS = {
  ratelimit: '"ip";r=9999;t=60, "starts-minute";r=11;t=60',
  "ratelimit-policy":
    '"ip";q=10000;w=60, "starts-minute";q=12;w=60, "starts-hour";q=60;w=3600, "starts-day";q=200;w=86400',
};

/** 202 from `POST /sandboxes`: the machine is assigned but not ready, and the port is already routed. */
export function created(): Response {
  return json(
    202,
    {
      ok: true,
      type: "sandbox.created",
      status: "provisioning",
      ttlSeconds: 900,
      sandbox: boatSandbox({
        state: "provisioned",
        sshEndpoint: null,
        desktopAvailable: false,
        subdomain: null,
        createdBy: null,
        createdById: null,
        visibility: "private",
        environment: null,
        environmentVersion: null,
      }),
      hostedPorts: [
        {
          success: true,
          port: 4500,
          url: `${ORIGIN}?_token=${TOKEN}`,
          isProtected: true,
          access: "private",
          localhost: false,
        },
      ],
    },
    START_LIMIT_HEADERS,
  );
}

export function info(sandbox = boatSandbox()): Response {
  return json(200, { ok: true, type: "sandbox.info", sandbox });
}

/** Every error has this envelope; `details` varies by code. */
export function refusal(
  status: number,
  code: string,
  message: string = code,
  extra: {
    details?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: object;
  } = {},
): Response {
  return json(
    status,
    {
      ok: false,
      type: "sandbox.error",
      status,
      code,
      message,
      error: { code, message, status, details: { error: code, message, ...extra.details } },
      requestId: "req_cc05f95d565c4828bdc85ad3f5800ec3",
      ...extra.body,
    },
    extra.headers,
  );
}

export const notFound = () => refusal(404, "not_found");

const STOPPED = `Sandbox ${ID} is stopped. Run \`boat resume ${ID}\`, then retry.`;

/** A command or file call to a sandbox that is asleep. */
export const machineNotRunning = (status = 409) =>
  refusal(status, "machine_not_running", STOPPED, {
    details: { state: "archived", retryable: false },
  });

/** A command to a sandbox that is on its way to sleep. */
export const sandboxNotReady = () =>
  refusal(409, "sandbox_not_ready", STOPPED, {
    details: { ok: false, code: "sandbox_not_ready", retryable: false, state: "archiving" },
  });

/** A resume sent just after a stop. boat still said this 100 ms after the sandbox read `archived`. */
export const sandboxStopping = () =>
  refusal(
    409,
    "sandbox_stopping",
    "Sandbox is still stopping. Wait for it to reach stopped, then resume.",
    {
      details: {
        operation: completedStop,
        statusUrl: `/api/v1/sandboxes/${ID}/stops/stop_92d0d14cf831adf9`,
        sandbox: asleepSandbox(),
      },
      headers: { "retry-after": "5" },
    },
  );

/** Documented, not recorded: a start limit is full. */
export const rateLimited = () =>
  refusal(429, "rate_limited", "Start limit reached: 12 starts per minute.", {
    headers: { "retry-after": "37" },
    body: {
      window: "minute",
      limit: 12,
      cause: "plan",
      nextStartAt: "2026-11-10T16:20:07.000Z",
      retryAfterSeconds: 37,
    },
  });

/** Documented, not recorded: the stopped sandbox's disk was deleted after 14 days. */
export const snapshotDataExpired = () =>
  refusal(409, "snapshot_data_expired", "This sandbox's snapshot data has expired.");

/** A resume that boots a machine: 202, and the start counts against the limits in the headers. */
export function coldResume(): Response {
  return json(
    202,
    {
      ok: true,
      type: "sandbox.resuming",
      id: ID,
      status: "resuming",
      sandbox: boatSandbox({
        state: "provisioned",
        hydrated: false,
        archiveAfter: "2026-11-10T16:34:06.550Z",
        stop: completedStop,
      }),
    },
    START_LIMIT_HEADERS,
  );
}

/** A resume inside the warm window, or of a sandbox that never slept: 200 and already running. */
export function warmResume(): Response {
  return json(200, {
    ok: true,
    type: "sandbox.resuming",
    id: ID,
    status: "running",
    sandbox: boatSandbox({ archiveAfter: "2026-11-10T16:33:57.643Z", stop: completedStop }),
  });
}

export function stopping(): Response {
  const operation = {
    id: "stop_9a2d1d578722d2fb",
    status: "pending",
    requestedAt: "2026-11-10T16:19:00.663Z",
    lastAttemptAt: null,
    error: null,
    endedAt: null,
    forced: false,
  };
  return json(202, {
    ok: true,
    type: "sandbox.stopping",
    id: ID,
    status: "archiving",
    forced: false,
    operation,
    statusUrl: `/api/v1/sandboxes/${ID}/stops/${operation.id}`,
    sandbox: boatSandbox({ state: "archiving", stop: operation }),
  });
}

/** Stopping a sandbox that already sleeps is a 200 carrying its last stop. */
export function alreadyStopped(): Response {
  return json(200, {
    ok: true,
    type: "sandbox.stopping",
    id: ID,
    status: "archived",
    forced: false,
    operation: completedStop,
    statusUrl: `/api/v1/sandboxes/${ID}/stops/${completedStop.id}`,
    sandbox: asleepSandbox(),
  });
}

export function deleting(): Response {
  return json(202, {
    ok: true,
    type: "sandbox.deleting",
    operation: {
      id: "bdop_b6cb52ffa2e24fc1a9cebc4717247dc9",
      kind: "sandbox",
      targetId: ID,
      reason: "explicit",
      status: "pending",
      stage: "removing",
      expectedBy: null,
      attemptCount: 0,
      requestedAt: "2026-11-10T16:19:10.965Z",
      completedAt: null,
    },
  });
}

export function commandFinished(overrides: Record<string, unknown> = {}): Response {
  return json(200, {
    ok: true,
    type: "command.finished",
    success: true,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    startedAt: "2026-11-10T16:18:31.511Z",
    finishedAt: "2026-11-10T16:18:31.529Z",
    launcherFailed: false,
    startMs: 14,
    noticedMs: 14,
    oomKilled: false,
    cwd: ".",
    commandId: "cmd_moan3wsfu0v7",
    ...overrides,
  });
}

/** `echo out-1; echo err-1 >&2; sleep 0.3; printf 'no newline'; exit 4`, streamed. */
export const STREAM_LINES = [
  '{"type":"started","commandId":"cmd_hkc8xllgwlqq"}',
  '{"type":"stdout","data":"out-1\\n"}',
  '{"type":"stderr","data":"err-1\\n"}',
  '{"type":"stdout","data":"no newline"}',
  '{"type":"exit","success":false,"exitCode":4,"signal":null,"stdoutTruncated":false,"stderrTruncated":false,"timedOut":false,"startedAt":"2026-11-10T16:18:33.519Z","finishedAt":"2026-11-10T16:18:33.826Z","launcherFailed":false,"startMs":1,"noticedMs":4,"oomKilled":false,"cwd":"."}',
];

/** An ndjson response delivered in the given byte chunks. */
export function stream(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } },
  );
}

export function processStatus(overrides: Record<string, unknown> = {}): Response {
  return json(200, {
    ok: true,
    type: "command.status",
    success: true,
    processId: 6169,
    pid: 6169,
    status: "running",
    known: true,
    running: true,
    exitCode: null,
    signal: null,
    oomKilled: false,
    command: "python3 -m http.server 4500",
    cwd: "work",
    startedAt: "2026-11-10T16:18:36.469Z",
    finishedAt: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    logPath: "/home/user/.ascii/processes/6169.log",
    errLogPath: "/home/user/.ascii/processes/6169.err.log",
    ...overrides,
  });
}

export function savedSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "ponzu-base-v1",
    status: "ready",
    sourceSandboxId: ID,
    snapshotId: "f86f27c0-65b5-47c6-8792-1cd1c36bf319",
    type: "small",
    sizeBytes: 6418432,
    createdAt: "2026-11-10T16:18:41.729Z",
    ...overrides,
  };
}
