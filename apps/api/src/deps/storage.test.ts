import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@ponzu/sandbox";
import {
  createR2Storage,
  deleteBody,
  MAX_DELETE_KEYS,
  parseDeleteErrors,
  parseList,
} from "./storage.ts";

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
