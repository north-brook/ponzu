import type { Api } from "../api.ts";
import type { Clock } from "../clock.ts";
import { ApiError } from "../errors.ts";

/*
 * A person's own Claude, in memory, behind `/v1/claude` as the API answers it: an API key that
 * Anthropic takes or not, a claude.ai sign-in good for ten minutes and one code, and the model
 * and effort new designs start on. Tests say which keys and codes are good.
 */

type ClaudeView = NonNullable<Awaited<ReturnType<Api["claude"]["get"]>>["account"]>;
type Defaults = Awaited<ReturnType<Api["claude"]["defaults"]>>;
type Effort = Defaults["effort"];

type OfferedModel = Defaults["models"][number];

/** The API's `DEFAULT_MODEL` and `DEFAULT_EFFORT`: what new designs run on until a person chooses. */
const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_EFFORT: Effort = "medium";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
/**
 * As the API's hand-kept list (apps/api/src/claude/models.ts): what an account is offered until
 * a runner on it reports what its Claude Code offers.
 */
export const KNOWN_MODELS: OfferedModel[] = [
  { id: "claude-fable-5-2", label: "Fable 5.2", efforts: EFFORTS },
  { id: "claude-opus-5-5", label: "Opus 5.5", efforts: EFFORTS },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: EFFORTS },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: EFFORTS },
];
const SIGN_IN_MS = 10 * 60_000;
const YEAR_MS = 365 * 24 * 3600_000;
const RENEW_AHEAD_MS = 28 * 24 * 3600_000;

interface StoredAccount {
  kind: "subscription" | "api_key";
  keyHint: string | null;
  connectedAt: number;
  expiresAt: number | null;
}

interface SignIn {
  id: string;
  userId: string;
  expiresAt: number;
  used: boolean;
}

export class FakeClaude {
  /** What Anthropic takes as an API key. Every key unless a test says otherwise. */
  acceptsKey: (key: string) => boolean = () => true;
  /** What claude.ai's sign-in takes as its code, once a code is whole. */
  acceptsCode: (code: string) => boolean = () => true;
  /** While true, a sign-in cannot be started: Claude can't be reached. */
  unreachable = false;
  /** While true, a sign-in cannot be started: the person has started too many this hour. */
  limited = false;
  /** Starts held by `holdStarts`, until `releaseStarts`: the API wakes a sandbox for each. */
  private held: { promise: Promise<void>; release: () => void } | null = null;
  /** The address each sign-in opens, for a test to check. */
  readonly opened: string[] = [];

  private readonly accounts = new Map<string, StoredAccount>();
  private readonly defaults = new Map<string, { model: string; effort: Effort }>();
  /** What each person's account offers, once a test says a runner reported it. */
  private readonly offered = new Map<string, OfferedModel[]>();
  private readonly signIns = new Map<string, SignIn>();
  private ids = 0;

  constructor(private readonly clock: Clock) {}

  /** Sign-ins started from now wait, as one waking its sandbox does, until `releaseStarts`. */
  holdStarts(): void {
    if (this.held) return;
    let release!: () => void;
    const promise = new Promise<void>((done) => {
      release = done;
    });
    this.held = { promise, release };
  }

  /** Every held start goes on. */
  releaseStarts(): void {
    this.held?.release();
    this.held = null;
  }

  /** Connect `userId`'s Claude without the round trip, as another device would have. */
  connect(userId: string, kind: StoredAccount["kind"] = "subscription", expiresAt?: number): void {
    const now = this.clock.now();
    this.accounts.set(userId, {
      kind,
      keyHint: kind === "api_key" ? "4f2a" : null,
      connectedAt: now,
      expiresAt: kind === "api_key" ? null : (expiresAt ?? now + YEAR_MS),
    });
    this.offered.delete(userId);
  }

  /**
   * `userId`'s account offers these, in this order, as the API does once a runner on it has
   * reported what Claude Code offers (the API names and orders them; this takes them as given).
   */
  offer(userId: string, models: OfferedModel[]): void {
    this.offered.set(userId, models);
  }

  /** What `userId`'s account offers. */
  modelsOf(userId: string): OfferedModel[] {
    return this.offered.get(userId) ?? KNOWN_MODELS;
  }

  /** As the API refuses a model or effort the account does not offer. */
  checkOffered(userId: string, model: string, effort: string | undefined): void {
    const offered = this.modelsOf(userId).find((m) => m.id === model);
    // As the API, an effort sent with a model that takes none is let through, not refused.
    const refusedEffort =
      effort !== undefined &&
      offered !== undefined &&
      offered.efforts.length > 0 &&
      !(offered.efforts as string[]).includes(effort);
    if (!offered || refusedEffort) {
      throw new ApiError(400, "model_not_offered", "Your Claude account doesn't offer that model.");
    }
  }

  /** The person's Claude as `/v1/me` and `/v1/claude` show it, or null. */
  view(userId: string): ClaudeView | null {
    const account = this.accounts.get(userId);
    if (!account) return null;
    const now = this.clock.now();
    const expired = account.expiresAt !== null && account.expiresAt <= now;
    return {
      kind: account.kind,
      status: expired ? "expired" : "connected",
      label:
        account.kind === "api_key"
          ? `Anthropic API key · sk-ant-…${account.keyHint}`
          : "Claude subscription",
      email: null,
      connectedAt: new Date(account.connectedAt).toISOString(),
      expiresAt: account.expiresAt === null ? null : new Date(account.expiresAt).toISOString(),
      expiresSoon: account.expiresAt !== null && account.expiresAt - now < RENEW_AHEAD_MS,
      limitedUntil: null,
    };
  }

  /**
   * How many of `userId`'s sign-ins still take a code: each is a sandbox the API pays for until
   * it is used, abandoned, replaced or out of time.
   */
  openSignIns(userId: string): number {
    const now = this.clock.now();
    return [...this.signIns.values()].filter(
      (s) => s.userId === userId && !s.used && s.expiresAt > now,
    ).length;
  }

  /** `/v1/claude` as one person. */
  api(userId: string, changed: () => void): Api["claude"] {
    const answer = () => ({ account: this.view(userId) });
    const connected = (kind: StoredAccount["kind"], keyHint: string | null = null) => {
      const now = this.clock.now();
      this.accounts.set(userId, {
        kind,
        keyHint,
        connectedAt: now,
        expiresAt: kind === "subscription" ? now + YEAR_MS : null,
      });
      // As the API clears a report when the credential changes.
      this.offered.delete(userId);
      changed();
      return answer();
    };
    return {
      get: async () => answer(),
      connectApiKey: async (key) => {
        if (!this.acceptsKey(key)) {
          throw new ApiError(400, "claude_key_invalid", "Anthropic didn't accept that key.");
        }
        return connected("api_key", key.slice(-4));
      },
      startSignIn: async () => {
        if (this.held) await this.held.promise;
        if (this.unreachable) {
          throw new ApiError(502, "upstream_unavailable", "Claude couldn't be reached.");
        }
        if (this.limited) {
          throw new ApiError(
            429,
            "rate_limited",
            "You've started signing in to Claude several times this hour. Try again later.",
          );
        }
        for (const open of this.signIns.values()) if (open.userId === userId) open.used = true;
        const id = `csi_${String(++this.ids).padStart(16, "0")}`;
        const expiresAt = this.clock.now() + SIGN_IN_MS;
        this.signIns.set(id, { id, userId, expiresAt, used: false });
        const authorizeUrl = `https://claude.ai/oauth/authorize?code=true&state=${id}`;
        this.opened.push(authorizeUrl);
        return { id, authorizeUrl, expiresAt: new Date(expiresAt).toISOString() };
      },
      sendCode: async (signInId, code) => {
        const signIn = this.signIns.get(signInId);
        if (!signIn || signIn.userId !== userId) {
          throw new ApiError(404, "not_found", "There is no such sign-in.");
        }
        if (!code.includes("#")) {
          throw new ApiError(
            400,
            "claude_code_invalid",
            "That code isn't complete. Copy all of it.",
          );
        }
        if (signIn.used) {
          throw new ApiError(
            409,
            "claude_sign_in_used",
            "That sign-in has been used. Open sign-in again for a new code.",
          );
        }
        if (signIn.expiresAt <= this.clock.now()) {
          throw new ApiError(410, "claude_sign_in_expired", "That code has expired.");
        }
        signIn.used = true;
        if (!this.acceptsCode(code)) {
          throw new ApiError(
            400,
            "claude_code_invalid",
            "Claude didn't accept that code. Open sign-in again for a new one.",
          );
        }
        return connected("subscription");
      },
      abandonSignIn: async (signInId) => {
        const signIn = this.signIns.get(signInId);
        if (!signIn || signIn.userId !== userId) {
          throw new ApiError(404, "not_found", "There is no such sign-in.");
        }
        signIn.used = true;
      },
      disconnect: async () => {
        this.accounts.delete(userId);
        this.offered.delete(userId);
        changed();
      },
      defaults: async () => this.defaultsOf(userId),
      setDefaults: async (body) => {
        const was = this.defaultsOf(userId);
        this.checkOffered(userId, body.model ?? was.model, body.effort);
        this.defaults.set(userId, {
          model: body.model ?? was.model,
          effort: body.effort ?? was.effort,
        });
        changed();
        return this.defaultsOf(userId);
      },
    };
  }

  /**
   * What `userId`'s new designs start on: the saved choice while the account offers it, or the
   * default (Opus 5.5 on medium when offered, else the first offered), as the API answers it.
   */
  defaultsOf(userId: string): Defaults {
    const chosen = this.defaults.get(userId);
    const models = this.modelsOf(userId);
    const fallback = models.find((m) => m.id === DEFAULT_MODEL) ?? models[0]!;
    const model = models.find((m) => m.id === chosen?.model) ?? fallback;
    const effort =
      chosen && model.efforts.includes(chosen.effort)
        ? chosen.effort
        : model.efforts.includes(DEFAULT_EFFORT)
          ? DEFAULT_EFFORT
          : (model.efforts[0] ?? DEFAULT_EFFORT);
    return {
      model: model.id,
      effort,
      models,
      efforts: EFFORTS.filter((e) => models.some((m) => m.efforts.includes(e))),
    };
  }
}
