import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@ponzu/sandbox";
import {
  createR2Storage,
  deleteBody,
  encodePath,
  MAX_DELETE_KEYS,
  parseDeleteErrors,
  parseList,
  presign,
  signHeaders,
  uploadHeaders,
} from "./storage.ts";

// The example in AWS's own documentation of a presigned URL ("Authenticating Requests: Using
// Query Parameters"), whose signature it gives: a signer that gets any part of the canonical
// request wrong gets another.
const AWS_EXAMPLE = {
  credentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  },
  now: Date.UTC(2013, 4, 24),
};

test("a presigned GET matches AWS's documented example to the signature", async () => {
  const url = await presign(AWS_EXAMPLE.credentials, {
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: {},
    now: AWS_EXAMPLE.now,
    expiresIn: 86_400,
  });

  expect(url.searchParams.get("X-Amz-Credential")).toBe(
    "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
  );
  expect(url.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z");
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(url.searchParams.get("X-Amz-Signature")).toBe(
    "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("every header given is bound into the signature, by its lowercase name", async () => {
  const sign = (headers: Record<string, string>) =>
    presign(AWS_EXAMPLE.credentials, {
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/a.png"),
      headers,
      now: AWS_EXAMPLE.now,
      expiresIn: 600,
    });

  const png = await sign({ "Content-Type": "image/png", "content-length": "10" });
  const svg = await sign({ "content-type": "image/svg+xml", "content-length": "10" });

  expect(png.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  expect(png.searchParams.get("X-Amz-Signature")).not.toBe(svg.searchParams.get("X-Amz-Signature"));
});

test("a signed request carries its date, an unsigned payload and the authorization", async () => {
  const headers = await signHeaders(AWS_EXAMPLE.credentials, {
    method: "HEAD",
    url: new URL("https://examplebucket.s3.amazonaws.com/a.png"),
    headers: { "Accept-Encoding": "identity" },
    now: AWS_EXAMPLE.now,
  });

  expect(headers).toMatchObject({
    "accept-encoding": "identity",
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-date": "20130524T000000Z",
  });
  expect(headers.authorization).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=accept-encoding;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
});

// The two signatures below are what the API's own SigV4 signer (sigv4.ts, before aws4fetch)
// gave for these requests. aws4fetch must give the same, byte for byte, on every header R2
// checks: the checksum, the length, the type, the cache rule and the disposition.
const R2 = { accessKeyId: "id", secretAccessKey: "secret", region: "auto" };
const R2_NOW = Date.UTC(2026, 10, 10);

test("an upload address signs what the hand signer signed, to the signature", async () => {
  const headers = uploadHeaders({
    contentType: "image/png",
    size: 5,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    cacheControl: "public, max-age=31536000, immutable",
    contentDisposition: "attachment",
  });
  const url = await presign(R2, {
    method: "PUT",
    url: new URL(
      "https://acct.r2.cloudflarestorage.com/canvases/k3y/assets/Team%20photo%20%281%29.png",
    ),
    headers: { ...headers, "content-length": "5" },
    now: R2_NOW,
    expiresIn: 600,
  });

  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
    "cache-control;content-disposition;content-length;content-type;host;x-amz-checksum-sha256",
  );
  expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
  expect(url.searchParams.get("X-Amz-Signature")).toBe(
    "9029464ef580906bc8fd3ae32de4bff3bc7e428d50e4763feb8a869d880a74e2",
  );
});

test("a signed request to R2 is what the hand signer sent, to the signature", async () => {
  const headers = await signHeaders(R2, {
    method: "HEAD",
    url: new URL("https://acct.r2.cloudflarestorage.com/canvases/k3y/assets/a.png"),
    headers: { "Accept-Encoding": "identity", "x-amz-checksum-mode": "ENABLED" },
    now: R2_NOW,
  });

  expect(headers).toEqual({
    "accept-encoding": "identity",
    "x-amz-checksum-mode": "ENABLED",
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-date": "20261110T000000Z",
    authorization:
      "AWS4-HMAC-SHA256 Credential=id/20261110/auto/s3/aws4_request, " +
      "SignedHeaders=accept-encoding;host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date, " +
      "Signature=cf801d605e0306608304e3d19dee82b2de886c139923b6a9cfcb667ae2ee1491",
  });
});

test("a key is encoded segment by segment, as S3 signs it", () => {
  expect(encodePath("k3y/assets/Team photo (1)!.png")).toBe(
    "k3y/assets/Team%20photo%20%281%29%21.png",
  );
});

const SHA256 = createHash("sha256").update("bytes").digest();

/** R2 as S3 answers a HEAD: the checksum only to a request that asks for it. */
function storage(objects: Record<string, number>) {
  const seen: Request[] = [];
  const r2 = createR2Storage({
    accountId: "acct",
    accessKeyId: "id",
    secretAccessKey: "secret",
    bucket: "canvases",
    clock: new FakeClock(Date.UTC(2026, 10, 10)),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      const size = objects[new URL(request.url).pathname];
      if (size === undefined) return new Response(null, { status: 404 });
      const headers = new Headers({ "content-length": String(size), "content-type": "image/png" });
      if (request.headers.get("x-amz-checksum-mode") === "ENABLED") {
        headers.set("x-amz-checksum-sha256", SHA256.toString("base64"));
      }
      return new Response(null, { status: 200, headers });
    },
  });
  return { r2, seen };
}

test("a HEAD asks for the object's checksum and reads it back as hex", async () => {
  const { r2, seen } = storage({ "/canvases/k/assets/a.png": 5 });

  expect(await r2.head("k/assets/a.png")).toEqual({
    size: 5,
    contentType: "image/png",
    sha256: SHA256.toString("hex"),
  });
  expect(await r2.head("k/assets/missing.png")).toBeNull();
  expect(seen[0]!.method).toBe("HEAD");
  expect(seen[0]!.headers.get("authorization")).toContain("x-amz-checksum-mode");
});

const KEY = "0123456789abcdefghjkmnpqrstvwxyz";
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

/** R2 answering every request with `answer`, keeping what it was asked. */
function answering(answer: (request: Request, body: string) => Response) {
  const seen: { request: Request; body: string }[] = [];
  const r2 = createR2Storage({
    accountId: "acct",
    accessKeyId: "id",
    secretAccessKey: "secret",
    bucket: "canvases",
    clock: new FakeClock(Date.UTC(2026, 10, 10)),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.clone().text();
      seen.push({ request, body });
      return answer(request, body);
    },
  });
  return { r2, seen };
}

test("a list asks ListObjectsV2 for one prefix after a key, and reads R2's answer", async () => {
  const { r2, seen } = answering(() => new Response(fixture("r2-list.xml"), { status: 200 }));

  const logo = `${KEY}/assets/logo.svg`;
  const salt = `${KEY}/assets/salt & pepper <v2>.png`;
  const dark = `${KEY}/previews/41-dark.png`;
  expect(await r2.list(`${KEY}/`, { after: `${KEY}/assets/a.png` })).toEqual({
    keys: [logo, salt, dark],
    // When each was last written, which the orphan archive sweep goes by.
    objects: [
      { key: logo, modifiedAt: new Date("2026-11-10T18:02:11.204Z") },
      { key: salt, modifiedAt: new Date("2026-11-10T18:02:12.881Z") },
      { key: dark, modifiedAt: new Date("2026-11-11T09:40:03.017Z") },
    ],
    truncated: true,
  });
  const url = new URL(seen[0]!.request.url);
  expect(seen[0]!.request.method).toBe("GET");
  expect(url.origin + url.pathname).toBe("https://acct.r2.cloudflarestorage.com/canvases");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    "list-type": "2",
    prefix: `${KEY}/`,
    "max-keys": "1000",
    "start-after": `${KEY}/assets/a.png`,
  });
  expect(seen[0]!.request.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 ");
});

test("a list sends its query exactly as it signs it, a space as %20 and never +", async () => {
  const { r2, seen } = answering(() => new Response(fixture("r2-list.xml"), { status: 200 }));
  await r2.list(`${KEY}/`, { after: `${KEY}/assets/b & c*.txt` });
  expect(new URL(seen[0]!.request.url).search).toBe(
    `?list-type=2&max-keys=1000&prefix=${KEY}%2F&start-after=${KEY}%2Fassets%2Fb%20%26%20c%2A.txt`,
  );
});

test("a list with nothing under the prefix is empty and whole", () => {
  const empty =
    '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>canvases</Name>' +
    "<IsTruncated>false</IsTruncated><MaxKeys>1000</MaxKeys><KeyCount>0</KeyCount></ListBucketResult>";
  expect(parseList(empty)).toEqual({ keys: [], objects: [], truncated: false });
});

test("a list storage refuses throws with its status", async () => {
  const { r2 } = answering(
    () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
  );
  await expect(r2.list(`${KEY}/`)).rejects.toMatchObject({ name: "UpstreamError", status: 403 });
});

test("a delete of many posts one quiet DeleteObjects body with its signed checksum", async () => {
  const { r2, seen } = answering(
    () => new Response('<?xml version="1.0" encoding="UTF-8"?><DeleteResult/>', { status: 200 }),
  );

  await r2.deleteMany([`${KEY}/assets/a&b.png`, `${KEY}/previews/1-light.png`]);

  const { request, body } = seen[0]!;
  expect(request.method).toBe("POST");
  expect(new URL(request.url).search).toBe("?delete=");
  expect(body).toBe(
    '<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>' +
      `<Object><Key>${KEY}/assets/a&amp;b.png</Key></Object>` +
      `<Object><Key>${KEY}/previews/1-light.png</Key></Object></Delete>`,
  );
  expect(request.headers.get("x-amz-checksum-sha256")).toBe(
    createHash("sha256").update(body).digest("base64"),
  );
  expect(request.headers.get("authorization")).toContain("x-amz-checksum-sha256");
});

test("a delete of many throws when R2 says it could not remove a key", async () => {
  const { r2 } = answering(() => new Response(fixture("r2-delete-errors.xml"), { status: 200 }));
  await expect(r2.deleteMany([`${KEY}/assets/logo.svg`])).rejects.toThrow(
    "could not remove 1 of 1 objects (AccessDenied)",
  );
  expect(parseDeleteErrors(fixture("r2-delete-errors.xml"))).toEqual(["AccessDenied"]);
});

test("a delete of many takes at most a thousand keys and asks nothing for none", async () => {
  const { r2, seen } = answering(() => new Response(null, { status: 200 }));
  await r2.deleteMany([]);
  const many = Array.from({ length: MAX_DELETE_KEYS + 1 }, (_, i) => `${KEY}/assets/${i}`);
  await expect(r2.deleteMany(many)).rejects.toThrow("at most 1000 keys");
  expect(seen).toEqual([]);
  expect(deleteBody(["<&>\"'"])).toContain("<Key>&lt;&amp;&gt;&quot;&apos;</Key>");
});
