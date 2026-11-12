/*
 * The one seam between Ponzu and Vercel Sandbox. `vercelSandboxes` is the real thing and
 * `FakeSandboxes` stands in for it in tests. There is no provider abstraction: one vendor.
 *
 * The rule that shapes it: only `up()` resumes. Every other call is pinned to one session
 * (`At`) and fails as `not_running` rather than wake anything.
 */

/** All three or none. None: the SDK's OIDC, valid only inside a request or work kept by it. */
export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/** One exact session of one sandbox. Calls on anything else are `not_running`. */
export interface At {
  name: string;
  sessionId: string;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface SandboxSpec {
  /** Project-VCR reference by digest, "ponzu-runner@sha256:…" (current.json `image`). A different digest recreates. */
  image: string;
  /** true for canvases; false for the Claude sign-in and checks. */
  persistent: boolean;
  /** Session timeout (backstop). Canvases: SESSION_TIMEOUT_MS. */
  timeoutMs: number;
  /** Public ports. Canvases: [4600]. Sign-in: []. */
  ports: number[];
  /** Default 2 (2048 MB per vCPU). */
  vcpus?: 2 | 4 | 8;
  /** Persistent only. keepLastSnapshots is always { count: 1, deleteEvicted: true }. */
  snapshotExpirationMs?: number;
}

export interface Up {
  name: string;
  /** The running session every later call pins to. */
  sessionId: string;
  /** Epoch ms the session started (Session.startedAt). */
  startedAt: number;
  /** Epoch ms deadline: startedAt + session timeout. */
  expiresAt: number;
  /** As Vercel reports it: "{repository}@{manifestDigest}". */
  image: string;
  /** https origin per requested port. Public. */
  urls: Record<number, string>;
  /** The session booted on an empty disk (created, recreated, snapshot expired, or removed after 14 days). */
  fresh: boolean;
  /** This call deleted a sandbox on another image digest (without booting it) and created it again. */
  recreated: boolean;
  /** The session was already running before this call: its processes are whatever was left there. */
  wasRunning: boolean;
}

export interface Command {
  cmd: string;
  args?: string[];
  /** This one command's environment: the only place a secret may go. */
  env?: Record<string, string>;
  sudo?: boolean;
  cwd?: string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type VercelStatus =
  | "pending"
  | "running"
  | "stopping"
  | "snapshotting"
  | "stopped"
  | "failed"
  | "aborted";

export interface SandboxInfo {
  name: string;
  status: VercelStatus;
  /** The current (or last) session's id. */
  sessionId: string | null;
  image: string | null;
  createdAt: number;
}

export interface Sandboxes {
  /**
   * THE ONLY CALL THAT RESUMES. get({resume:false}) first; 404 → create; image digest differs →
   * delete({deleteOrphanSnapshots:true}) + create; other config drift → sandbox.update(); then the running
   * session, or getOrCreate({resume:true}) (which absorbs snapshot_not_found). Resolves with a running session.
   */
  up(name: string, spec: SandboxSpec, options?: CallOptions): Promise<Up>;
  /** get({resume:false}). Never resumes. Null when missing. */
  status(name: string, options?: CallOptions): Promise<SandboxInfo | null>;
  /** list({ namePrefix, sortBy: "name" }), all pages. */
  list(prefix: string, options?: CallOptions): Promise<SandboxInfo[]>;
  /** Detached Session.runCommand in `at`; resolves once accepted. Never resumes. */
  start(at: At, command: Command, options?: CallOptions): Promise<{ commandId: string }>;
  /** Waited Session.runCommand in `at`. Never resumes. */
  exec(
    at: At,
    command: Command & { timeoutMs: number },
    options?: CallOptions,
  ): Promise<ExecResult>;
  /** Session.writeFiles in `at`. Never resumes. */
  writeFile(
    at: At,
    path: string,
    content: string | Uint8Array,
    options?: CallOptions & { mode?: number },
  ): Promise<void>;
  /** Session.readFileToBuffer in `at`; null when missing. Never resumes. */
  readFile(at: At, path: string, options?: CallOptions): Promise<Uint8Array | null>;
  /** Session.extendTimeout(ms) (returns void in 3.9.1); answers startedAt + timeout read back, or null when `at` is not running. */
  extend(at: At, ms: number, options?: CallOptions): Promise<number | null>;
  /** Session.stop() of `at`; snapshot when persistent. stopped:false when `at` was not running (success). */
  stop(at: At, options?: CallOptions): Promise<{ stopped: boolean; snapshotBytes: number | null }>;
  /** get({resume:false}) then delete({deleteOrphanSnapshots:true}). Missing is success. */
  remove(name: string, options?: CallOptions): Promise<void>;
}

/** The digest of an image reference: "sha256:…" from "repo@sha256:…" or a full VCR path. */
export function imageDigest(image: string | null | undefined): string | null {
  if (!image) return null;
  return /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1] ?? null;
}
