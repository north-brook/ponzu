import type { Clock } from "@ponzu/sandbox";
import { UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";

/**
 * What the API asks Anthropic itself. The agent talks to Anthropic from the sandbox; the API
 * only checks that an API key a person gives it is one Anthropic takes, and that its own is.
 */
export interface Anthropic {
  /**
   * Whether Anthropic accepts the key. Asks for the list of models, which costs nothing and
   * needs nothing but a valid key. Throws an `UpstreamError` when Anthropic did not answer.
   */
  acceptsApiKey(key: string): Promise<boolean>;
  /**
   * Whether Anthropic accepts Ponzu's own key (`PONZU_ANTHROPIC_API_KEY`), asked the same free
   * way: the selfcheck's question. The key never leaves this module.
   */
  acceptsOwnKey(): Promise<boolean>;
}

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
const TIMEOUT_MS = 10_000;

export function createAnthropic({
  fetch,
  clock,
  ownKey,
}: {
  fetch: Fetch;
  clock: Clock;
  /** Ponzu's own key, which `acceptsOwnKey` asks about. */
  ownKey: string;
}): Anthropic {
  async function acceptsApiKey(key: string): Promise<boolean> {
    let response: Response;
    try {
      response = await fetch(MODELS_URL, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: clock.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamError("anthropic", "Anthropic did not answer.", { cause: error });
    }
    await response.body?.cancel();
    // 401 is a key Anthropic does not know; 403 one it knows and will not let do this.
    if (response.status === 401 || response.status === 403) return false;
    if (!response.ok) {
      throw new UpstreamError("anthropic", `Anthropic answered ${response.status}.`, {
        status: response.status,
      });
    }
    return true;
  }

  return {
    acceptsApiKey,
    acceptsOwnKey: () => acceptsApiKey(ownKey),
  };
}
