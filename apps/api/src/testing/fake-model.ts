import {
  CLAUDE_HAIKU,
  type Model,
  type StructuredAnswer,
  type StructuredRequest,
} from "../deps/model.ts";
import { UpstreamError } from "../http/errors.ts";

/** What the fake answers one request with. */
export type FakeReply =
  /** The model's JSON, checked against the request's schema as the real one is. */
  | { output: unknown }
  /** No answer: the API failed with this status. */
  | { fail: number }
  /** No answer until the request's signal aborts (its timeout), then the failure that is. */
  | { hang: true };

/** Four ideas, the writer's answer when a test gives none. */
export const FAKE_IDEAS = [
  "Put the order summary beside the card form, all on one page",
  "Compare home heroes led by the plants, the care guides or the prices",
  "Show what went wrong when a card is declined at checkout",
  "Bring the leaf green into a dark theme for the whole shop",
];

/** A gate verdict on four ideas where those numbered in `unsafe` or `notDesign` fail. */
export function verdict({
  unsafe = [],
  notDesign = [],
}: {
  unsafe?: number[];
  notDesign?: number[];
} = {}) {
  return Object.fromEntries(
    [1, 2, 3, 4].map((n) => [
      `idea_${n}`,
      {
        reason: unsafe.includes(n)
          ? "It asks the reader to reconnect at an address."
          : notDesign.includes(n)
            ? "Caching is invisible."
            : "A design.",
        safe: !unsafe.includes(n),
        design: !notDesign.includes(n),
      },
    ]),
  );
}

/** The gate's verdict on four ideas, each safe and a design: its answer when a test gives none. */
export const PASSING_VERDICT = verdict();

/**
 * A model, in memory: it keeps every request it was sent (`requests`), so a test can read
 * the exact system prompt and user turn, and answers each from `replies` in order, then with
 * `otherwise`. Every answer costs the same made-up tokens. The writer (`CLAUDE_HAIKU`) answers
 * four ideas by default; the reviewer (`CLAUDE_SONNET`), a gate verdict passing all four.
 */
export class FakeModel implements Model {
  readonly id: string;
  readonly requests: StructuredRequest<unknown>[] = [];
  readonly replies: FakeReply[] = [];
  otherwise: FakeReply;
  readonly #arrivals: (() => void)[] = [];

  constructor(id: string = CLAUDE_HAIKU) {
    this.id = id;
    this.otherwise = { output: id === CLAUDE_HAIKU ? { ideas: FAKE_IDEAS } : PASSING_VERDICT };
  }

  /** Answer the next requests with these, in order. */
  reply(...replies: FakeReply[]): this {
    this.replies.push(...replies);
    return this;
  }

  /** Settles once `count` requests in all have arrived. */
  async received(count: number): Promise<void> {
    while (this.requests.length < count) {
      await new Promise<void>((resolve) => this.#arrivals.push(resolve));
    }
  }

  async structured<T>(request: StructuredRequest<T>): Promise<StructuredAnswer<T>> {
    this.requests.push(request as StructuredRequest<unknown>);
    for (const arrived of this.#arrivals.splice(0)) arrived();
    const reply = this.replies.shift() ?? this.otherwise;
    const usage = { input: 1_200, output: 90 };
    if ("fail" in reply) {
      throw new UpstreamError("model", `the model call failed (${reply.fail})`, {
        status: reply.fail,
      });
    }
    if ("hang" in reply) {
      await new Promise<never>((_, reject) => {
        const fail = () =>
          reject(new UpstreamError("model", "the model call failed (no answer)", {}));
        if (request.signal?.aborted) fail();
        request.signal?.addEventListener("abort", fail, { once: true });
      });
    }
    const parsed = request.schema.safeParse((reply as { output: unknown }).output);
    return { output: parsed.success ? parsed.data : null, finishReason: "stop", usage };
  }
}
