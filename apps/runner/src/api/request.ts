import { type ErrorBody, RUNNER_HEADER } from "./protocol.ts";

/** Long enough for a cold function and a slow database across the Atlantic, and no longer. */
export const TIMEOUT_MS = 15_000;

/** Where the API is and who is calling it. */
export interface Endpoint {
  /** `https://api.ponzu.design`. */
  baseUrl: string;
  /** The runner token. */
  token: string;
  /** Sent as `X-Ponzu-Client`, like `runner/0.1.0`. */
  client: string;
  /** The runner's lease, from the session: sent as `X-Ponzu-Runner` once there is one. */
  runnerId?: string | null;
  fetch?: typeof fetch;
}

/** The API answered with an error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Whether sending the same request again could go differently. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

/**
 * One JSON call with the runner token as the bearer, and the lease once there is one. Rejects
 * with `ApiError` for an error answer.
 */
export async function request<T>(
  endpoint: Endpoint,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${endpoint.token}`,
    "x-ponzu-client": endpoint.client,
  };
  if (endpoint.runnerId) headers[RUNNER_HEADER] = endpoint.runnerId;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await (endpoint.fetch ?? fetch)(new URL(path, endpoint.baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!response.ok) {
    const error = parse<ErrorBody>(text)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "unknown",
      error?.message ?? `The API answered ${response.status}.`,
    );
  }
  return JSON.parse(text) as T;
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
