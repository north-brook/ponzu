import type { Route } from "playwright-core";

/** What holds one fetch made for a page. */
export interface FetchBounds {
  /** The most a response body may hold; a bigger one is refused. */
  maxBytes: number;
  /** How long the whole response may take, in ms. */
  ms: number;
  /** Aborts the fetch: the page that asked has closed. */
  signal: AbortSignal;
}

/**
 * Answers a page's request with a fetch made from this process, for what
 * Chrome won't fetch for a render page or wouldn't let it read.
 *
 * The whole body is held here and then sent to Chrome down its pipe, so it
 * is bounded: a response past `maxBytes` is refused as soon as its length is
 * known or its stream passes that, one that takes longer than `ms` is
 * dropped, and both stop with the page. Without that a video on a dev server
 * cost this process a gigabyte, and a response that never ended kept filling
 * it after the render had returned.
 */
export async function fetchHere(route: Route, bounds: FetchBounds): Promise<void> {
  const request = route.request();
  const stop = new AbortController();
  try {
    // A design has no scripts or forms: everything it loads is a GET.
    if (request.method() !== "GET") throw new Error("Not a GET.");
    const response = await fetch(request.url(), {
      headers: sent(request.headers()),
      signal: AbortSignal.any([bounds.signal, stop.signal, AbortSignal.timeout(bounds.ms)]),
    });
    const body = await read(response, bounds.maxBytes);
    await route.fulfill({
      status: response.status,
      headers: {
        ...received(response.headers),
        // A font from another origin needs CORS, which a dev server rarely
        // sends with its static files. Designs run no scripts, so nothing on
        // the page can read what this lets through.
        "access-control-allow-origin": "*",
      },
      body,
    });
  } catch {
    await route.abort().catch(() => {});
  } finally {
    // Whatever is still arriving is of no use now.
    stop.abort();
  }
}

/** The body, or an error once it is known to be longer than `maxBytes`. */
async function read(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Too big.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (let next = await reader?.read(); next && !next.done; next = await reader?.read()) {
    size += next.value.byteLength;
    // The length a server states is of the bytes it sends, compressed or not; this is what they came to.
    if (size > maxBytes) throw new Error("Too big.");
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

/** The request's headers, less the ones the fetch here sets for itself. */
function sent(headers: Record<string, string>): Record<string, string> {
  const { "accept-encoding": _encoding, host: _host, connection: _connection, ...rest } = headers;
  return rest;
}

/** The response's headers, less the ones that described the body as it travelled: it arrives here decoded and whole. */
function received(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers)
    if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(name))
      out[name] = value;
  return out;
}
