import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPublicAddress, RemoteImages, rasterType, readCapped } from "./remote-images.ts";
import { imageRequestOk } from "./serve.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-remote-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/**
 * A fetcher from a table of URL → response, recording what it was asked. The
 * proxy connects to an address with the name as the Host header: `url` is put
 * back together from the two, `to` is where it connected.
 */
function fake(routes: Record<string, () => Response>) {
  const asked: { url: string; to: string; redirect?: RequestRedirect }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const to = new URL(String(input));
    const host = (init?.headers as Record<string, string> | undefined)?.host;
    const url = host ? `${to.protocol}//${host}${to.pathname}${to.search}` : to.href;
    asked.push({ url, to: to.hostname, redirect: init?.redirect });
    const r = routes[url];
    return r ? r() : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}
const publicDns = async () => ["93.184.216.34"];

test("only raster images, by their bytes, whatever the server calls them", async () => {
  expect(rasterType(PNG)).toBe("image/png");
  expect(rasterType(JPEG)).toBe("image/jpeg");
  expect(rasterType(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
  expect(rasterType(SVG)).toBeNull();
  expect(rasterType(new TextEncoder().encode("<!doctype html>"))).toBeNull();
  const { fetcher } = fake({
    "https://cdn.example/a.svg": () =>
      new Response(SVG, { headers: { "content-type": "image/svg+xml" } }),
    // Says it's a JPEG, is a PNG: served as what it is.
    "https://cdn.example/b": () => new Response(PNG, { headers: { "content-type": "image/jpeg" } }),
  });
  const r = new RemoteImages(join(dir, "a"), { fetcher, resolver: publicDns });
  expect(await r.get("https://cdn.example/a.svg")).toBeNull();
  expect((await r.get("https://cdn.example/b"))?.type).toBe("image/png");
});

test("never this Mac, the LAN or a metadata service, at any hop", async () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.5", "169.254.169.254"])
    expect(isPublicAddress(a)).toBe(false);
  for (const a of ["100.100.1.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1"])
    expect(isPublicAddress(a)).toBe(false);
  expect(isPublicAddress("93.184.216.34")).toBe(true);
  expect(isPublicAddress("2606:2800:220:1::1")).toBe(true);

  const { fetcher, asked } = fake({
    "https://cdn.example/x": () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    "https://cdn.example/y": () =>
      new Response(null, { status: 301, headers: { location: "https://img.example/y.png" } }),
    "https://img.example/y.png": () => new Response(PNG),
  });
  const r = new RemoteImages(join(dir, "b"), {
    fetcher,
    resolver: async (host) => (host === "inside.example" ? ["10.0.0.7"] : ["93.184.216.34"]),
  });
  // A host that resolves inside is never asked.
  expect(await r.get("https://inside.example/a.png")).toBeNull();
  expect(asked.some((a) => a.url.includes("inside.example"))).toBe(false);
  // A redirect into the metadata service stops there.
  expect(await r.get("https://cdn.example/x")).toBeNull();
  expect(asked.some((a) => a.url.includes("169.254"))).toBe(false);
  // A public redirect is followed, by hand.
  expect((await r.get("https://cdn.example/y"))?.type).toBe("image/png");
  expect(asked.every((a) => a.redirect === "manual")).toBe(true);
  // Every fetch went to the address that was checked, never the name.
  expect(asked.every((a) => a.to === "93.184.216.34")).toBe(true);
});

test("a name that resolves elsewhere the second time can't steer the fetch", async () => {
  // Public when checked, this Mac afterwards: the fetch goes to what was checked.
  let n = 0;
  const { fetcher, asked } = fake({ "https://rebind.example/a.png": () => new Response(PNG) });
  const r = new RemoteImages(join(dir, "d"), {
    fetcher,
    resolver: async () => (n++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]),
  });
  expect((await r.get("https://rebind.example/a.png"))?.type).toBe("image/png");
  expect(asked.map((a) => a.to)).toEqual(["93.184.216.34"]);
  expect(n).toBe(1);
  // IPv4-translated IPv6 is judged as the IPv4 address it carries.
  expect(isPublicAddress("::ffff:0:127.0.0.1")).toBe(false);
  expect(isPublicAddress("::ffff:0:7f00:1")).toBe(false);
});

test("a body past the limit stops being read", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(1000));
      if (pulled > 100) c.close();
    },
  });
  expect(await readCapped(new Response(body), 5000)).toBeNull();
  expect(pulled).toBeLessThan(10);
  expect((await readCapped(new Response(new Uint8Array(10)), 5000))?.length).toBe(10);
});

test("a few fetches at a time", async () => {
  let now = 0;
  let most = 0;
  const fetcher = (async () => {
    most = Math.max(most, ++now);
    await Bun.sleep(20);
    now--;
    return new Response(PNG);
  }) as unknown as typeof fetch;
  const r = new RemoteImages(join(dir, "c"), { fetcher, resolver: publicDns });
  await Promise.all(Array.from({ length: 12 }, (_, i) => r.get(`https://cdn.example/${i}.png`)));
  expect(most).toBeLessThanOrEqual(4);
});

test("a refused response lets go of its connection before the next fetch", async () => {
  const cancelled: string[] = [];
  const body = (name: string) =>
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled.push(name);
      },
    });
  const { fetcher } = fake({
    "https://cdn.example/gone.png": () => new Response(body("gone"), { status: 500 }),
    "https://cdn.example/huge.png": () =>
      new Response(body("huge"), { headers: { "content-length": String(1024 ** 3) } }),
  });
  const r = new RemoteImages(join(dir, "e"), { fetcher, resolver: publicDns });
  expect(await r.get("https://cdn.example/gone.png")).toBeNull();
  expect(await r.get("https://cdn.example/huge.png")).toBeNull();
  expect(cancelled).toEqual(["gone", "huge"]);
});

test("/api/image answers only this Mac's own pages, loading an image", () => {
  const url = new URL("http://127.0.0.1:7777/api/image?url=https://x/y.png");
  const req = (headers: Record<string, string>) => new Request(url, { headers });
  expect(imageRequestOk(req({ "sec-fetch-dest": "image" }), url, "local", "127.0.0.1")).toBe(true);
  expect(imageRequestOk(req({}), url, "local", "::1")).toBe(true);
  // A page sending the person here: a top-level navigation has no Origin, but says so.
  expect(imageRequestOk(req({ "sec-fetch-dest": "document" }), url, "local", "127.0.0.1")).toBe(
    false,
  );
  expect(imageRequestOk(req({ "sec-fetch-dest": "iframe" }), url, "local", "127.0.0.1")).toBe(
    false,
  );
  // Another site's page, another machine on the LAN, another Mac.
  expect(imageRequestOk(req({ origin: "https://evil.example" }), url, "local", "127.0.0.1")).toBe(
    false,
  );
  // Another site's <img> or no-cors fetch sends no Origin, but says it's cross-site.
  expect(
    imageRequestOk(
      req({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "image" }),
      url,
      "local",
      "127.0.0.1",
    ),
  ).toBe(false);
  expect(
    imageRequestOk(
      req({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" }),
      url,
      "local",
      "127.0.0.1",
    ),
  ).toBe(true);
  expect(imageRequestOk(req({}), url, "local", "192.168.1.9")).toBe(false);
  expect(imageRequestOk(req({}), url, "peer", "127.0.0.1")).toBe(false);
});
