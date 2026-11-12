import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FakeClock } from "@ponzu/sandbox";
import { createR2Storage } from "./storage.ts";

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
