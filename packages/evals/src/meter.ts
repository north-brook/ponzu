/*
 * What the evals spend, and the cap they stop at. Every model call an eval makes is priced from
 * its token usage by the table below and added up here, and a call is refused before it is
 * sent when the most it could cost would take the total past the cap. The design agent's turns
 * run on a Claude sign-in, not this key, so they are counted in turns (`TurnBudget`), not here.
 */

/** Dollars per million tokens, Anthropic's first-party prices (Haiku's for prompts under 100K). */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-fable-5-2": { input: 8, output: 40 },
};

export interface Usage {
  input: number;
  output: number;
}

export function price(model: string): { input: number; output: number } {
  const known = PRICES[model];
  if (!known) throw new Error(`No price for ${model}: add it to PRICES in packages/evals.`);
  return known;
}

export function costOf(model: string, usage: Usage): number {
  const { input, output } = price(model);
  return (usage.input * input + usage.output * output) / 1_000_000;
}

/** The cap would be passed by the next call: the run stops and says what was not run. */
export class SpendCapReached extends Error {
  override name = "SpendCapReached";
}

export interface MeteredCall {
  model: string;
  /** What asked: `judge:ideas`, `generate`, `gate`. */
  label: string;
  usage: Usage;
  usd: number;
}

/** What `Meter.reserve` holds back for one call in flight, until `record` or `release`. */
export interface Hold {
  usd: number;
}

export class Meter {
  spent = 0;
  /** The worst cases of the calls in flight: counted against the cap until each is recorded. */
  held = 0;
  readonly calls: MeteredCall[] = [];

  constructor(readonly capUsd: number) {}

  /**
   * Before a call: refuses it when its worst case (all of `maxOutputTokens` written, and the input
   * at two characters a token, more than any English text uses) would take what is spent, plus
   * what the calls in flight could still cost, past the cap. Otherwise it holds that worst case
   * back until the call is recorded (`record`) or given up (`release`), so calls made side by side
   * cannot pass the cap together.
   */
  reserve(
    model: string,
    { maxOutputTokens, inputChars }: { maxOutputTokens: number; inputChars: number },
  ): Hold {
    const worst = costOf(model, { input: Math.ceil(inputChars / 2), output: maxOutputTokens });
    if (this.spent + this.held + worst > this.capUsd) {
      const inFlight = this.held ? ` and $${this.held.toFixed(4)} is held for calls in flight` : "";
      throw new SpendCapReached(
        `stopped before a ${model} call that could cost up to $${worst.toFixed(4)}: $${this.spent.toFixed(4)} of the $${this.capUsd.toFixed(2)} cap is spent${inFlight}`,
      );
    }
    this.held += worst;
    return { usd: worst };
  }

  /** Gives back what `reserve` held for a call. A hold is released once; again does nothing. */
  release(hold: Hold | undefined) {
    if (!hold || hold.usd === 0) return;
    this.held = Math.max(0, this.held - hold.usd);
    hold.usd = 0;
  }

  /** After a call, what it really cost, and the release of its hold. */
  record(model: string, label: string, usage: Usage, hold?: Hold): number {
    this.release(hold);
    const usd = costOf(model, usage);
    this.spent += usd;
    this.calls.push({ model, label, usage, usd });
    return usd;
  }

  /** Spend so far by label, for the report. */
  byLabel(): Record<string, { calls: number; usd: number }> {
    const out: Record<string, { calls: number; usd: number }> = {};
    for (const call of this.calls) {
      const row = out[call.label] ?? { calls: 0, usd: 0 };
      out[call.label] = row;
      row.calls++;
      row.usd += call.usd;
    }
    return out;
  }
}

/** Real agent turns run on a Claude sign-in: they are capped by count. */
export class TurnBudget {
  used = 0;
  constructor(readonly max: number) {}

  take(label: string) {
    if (this.used >= this.max) {
      throw new SpendCapReached(`stopped before ${label}: all ${this.max} agent turns are used`);
    }
    this.used++;
  }
}
