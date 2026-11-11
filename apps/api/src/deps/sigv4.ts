/*
 * AWS Signature Version 4, as S3 (and Cloudflare R2's S3 API) takes it: the few requests the API
 * makes of storage, signed in an `Authorization` header, and addresses a client can PUT bytes to,
 * signed in their query string. On Web Crypto, so it needs no SDK: the AWS one is megabytes and
 * this is the part of it the API uses.
 *
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
 */

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 takes `auto`. */
  region: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED = "UNSIGNED-PAYLOAD";
const encoder = new TextEncoder();

export interface Signable {
  method: string;
  url: URL;
  /** Every header the request will carry that the signature should bind, `host` aside. */
  headers: Record<string, string>;
  /** Epoch milliseconds. */
  now: number;
}

/**
 * The headers to send with a request, `Authorization` among them. The body is not signed
 * (`UNSIGNED-PAYLOAD`): every request the API signs this way has none worth binding.
 */
export async function signHeaders(
  credentials: Credentials,
  request: Signable,
): Promise<Record<string, string>> {
  const { date, stamp } = times(request.now);
  const headers = {
    ...lower(request.headers),
    "x-amz-content-sha256": UNSIGNED,
    "x-amz-date": stamp,
  };
  const scope = `${date}/${credentials.region}/${SERVICE}/aws4_request`;
  const signed = canonicalHeaders(request.url, headers);
  const signature = await sign(credentials, date, scope, stamp, {
    method: request.method,
    url: request.url,
    query: request.url.searchParams,
    signed,
  });
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed.names}, Signature=${signature}`,
  };
}

/**
 * An address that takes this one request for `expiresIn` seconds, signed in its query string.
 * Whoever uses it must send every header in `request.headers` with exactly these values, or
 * storage refuses it.
 */
export async function presign(
  credentials: Credentials,
  request: Signable & { expiresIn: number },
): Promise<URL> {
  const { date, stamp } = times(request.now);
  const scope = `${date}/${credentials.region}/${SERVICE}/aws4_request`;
  const signed = canonicalHeaders(request.url, lower(request.headers));
  const url = new URL(request.url);
  url.searchParams.set("X-Amz-Algorithm", ALGORITHM);
  url.searchParams.set("X-Amz-Credential", `${credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", stamp);
  url.searchParams.set("X-Amz-Expires", String(request.expiresIn));
  url.searchParams.set("X-Amz-SignedHeaders", signed.names);
  const signature = await sign(credentials, date, scope, stamp, {
    method: request.method,
    url,
    query: url.searchParams,
    signed,
  });
  url.searchParams.set("X-Amz-Signature", signature);
  return url;
}

/** A path as S3 signs it: each segment encoded, the slashes between them kept. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeStrict).join("/");
}

async function sign(
  credentials: Credentials,
  date: string,
  scope: string,
  stamp: string,
  request: {
    method: string;
    url: URL;
    query: URLSearchParams;
    signed: { names: string; block: string };
  },
): Promise<string> {
  const query = [...request.query]
    .map(([key, value]) => [encodeStrict(key), encodeStrict(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonical = [
    request.method,
    // `URL` keeps a path as given once it is encoded, so this is the path as it is sent.
    request.url.pathname,
    query,
    request.signed.block,
    request.signed.names,
    UNSIGNED,
  ].join("\n");
  const toSign = [ALGORITHM, stamp, scope, hex(await sha256(canonical))].join("\n");
  let key: ArrayBuffer = encoder.encode(`AWS4${credentials.secretAccessKey}`).buffer as ArrayBuffer;
  for (const part of [date, credentials.region, SERVICE, "aws4_request"]) {
    key = await hmac(key, part);
  }
  return hex(await hmac(key, toSign));
}

function canonicalHeaders(url: URL, headers: Record<string, string>) {
  const all: Record<string, string> = { ...headers, host: url.host };
  const names = Object.keys(all).sort();
  return {
    names: names.join(";"),
    block: names.map((name) => `${name}:${all[name]!.trim().replace(/\s+/g, " ")}\n`).join(""),
  };
}

function lower(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

/** `encodeURIComponent`, and the five characters it leaves that S3 wants encoded. */
function encodeStrict(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function times(now: number) {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { date: stamp.slice(0, 8), stamp };
}

async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(data));
}

function sha256(data: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(data));
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
