import { expect, test } from "bun:test";
import { openAsBlob } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetResponse } from "./range.ts";

const bytes = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251));
const body = async (r: Response) => new Uint8Array(await r.arrayBuffer());

test("a range comes back as 206 with just those bytes", async () => {
  const blob = new Blob([bytes]);
  const cases: [string, number, number][] = [
    ["bytes=0-99", 0, 99],
    ["bytes=900-", 900, 999],
    ["bytes=-50", 950, 999],
    ["bytes=990-5000", 990, 999],
    ["bytes=-5000", 0, 999],
  ];
  for (const [range, start, end] of cases) {
    const r = assetResponse(blob, "video/webm", range);
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes ${start}-${end}/1000`);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-type")).toBe("video/webm");
    expect(await body(r)).toEqual(bytes.slice(start, end + 1));
  }
});

test("a range past the end is 416, and says how big the asset is", async () => {
  const blob = new Blob([bytes]);
  for (const range of ["bytes=1000-", "bytes=5000-6000", "bytes=-0", "bytes=50-10"]) {
    const r = assetResponse(blob, "video/webm", range);
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toBe("bytes */1000");
  }
  expect(assetResponse(new Blob([]), "video/webm", "bytes=0-").status).toBe(416);
});

test("no range, several or a malformed one get the whole asset", async () => {
  const blob = new Blob([bytes]);
  for (const range of [null, "bytes=0-1,5-9", "items=0-9", "bytes=-", "bytes=a-b"]) {
    const r = assetResponse(blob, "image/png", range);
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-range")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(await body(r)).toEqual(bytes);
  }
});

test("a file on disk is served in ranges through the server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ponzu-range-"));
  const file = join(dir, "clip.webm");
  await writeFile(file, bytes);
  const blob = await openAsBlob(file);
  // Through Bun.serve, which also knows Range for file blobs: the body is sliced once.
  const server = Bun.serve({
    port: 0,
    fetch: (req) => assetResponse(blob, "video/webm", req.headers.get("range")),
  });
  try {
    const url = `http://127.0.0.1:${server.port}/`;
    const part = await fetch(url, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(await body(part)).toEqual(bytes.slice(100, 200));
    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(await body(whole)).toEqual(bytes);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
