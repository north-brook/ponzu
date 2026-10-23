import { classify, NetError } from "./net";
import { USER_AGENT } from "./ua";

export { NetError } from "./net";

/**
 * A request to a Mac, with the phone's User-Agent, a timeout, and a failure
 * that says how it failed (see `classify`). Resolves with the body text of a
 * 2xx answer.
 */
export function request(
  url: string,
  opts: { timeout?: number; method?: "GET" | "POST"; body?: unknown } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method ?? "GET", url);
    xhr.timeout = opts.timeout ?? 10_000;
    xhr.setRequestHeader("User-Agent", USER_AGENT);
    if (opts.body !== undefined) xhr.setRequestHeader("Content-Type", "application/json");
    let timedOut = false;
    xhr.ontimeout = () => {
      timedOut = true;
    };
    xhr.onloadend = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.responseText);
      if (xhr.status > 0)
        return reject(new NetError("http", `${xhr.status} ${xhr.responseText}`, xhr.status));
      // On a network failure React Native leaves NSURLError's description as the response.
      const description = timedOut ? "timed out" : String(xhr.responseText ?? "");
      reject(new NetError(classify(description, timedOut), description));
    };
    xhr.send(opts.body === undefined ? null : JSON.stringify(opts.body));
  });
}

export async function getJson<T>(url: string, timeout?: number): Promise<T> {
  const text = await request(url, { timeout });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new NetError("http", "Not JSON");
  }
}
