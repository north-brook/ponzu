import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import sitemap from "./app/sitemap.ts";
import { FOOTER, NAV } from "./components/links.tsx";
import { guide, OSES } from "./components/platforms.ts";
import config from "./next.config.ts";

/*
 * The site's addresses, read from the tree as Next reads them: every page and route under app/,
 * every file in public/, and next.config.ts's redirects. Every internal link the site writes has
 * to land on one of them, and the sitemap lists exactly the pages meant for search.
 */

const ROOT = import.meta.dir;
const APP = join(ROOT, "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const rel = (path: string, from: string) => relative(from, path).split(sep).join("/");

/** A route's segments as Next reads them: route groups vanish, brackets are parameters. */
function routeOf(dir: string): string {
  const segments = dir.split("/").filter((s) => s && !/^\(.+\)$/.test(s));
  return `/${segments.join("/")}`;
}

function patternOf(route: string): RegExp {
  const body = route
    .split("/")
    .map((s) => {
      if (/^\[\[\.\.\..+\]\]$/.test(s)) return "(?:/.*)?";
      if (/^\[\.\.\..+\]$/.test(s)) return "/.+";
      if (/^\[.+\]$/.test(s)) return "/[^/]+";
      return s ? `/${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : "";
    })
    .join("");
  return new RegExp(`^${body || "/"}$`);
}

/** Metadata files Next serves under their own names. */
const METADATA: Record<string, string> = {
  "sitemap.ts": "sitemap.xml",
  "robots.ts": "robots.txt",
  "manifest.ts": "manifest.webmanifest",
  "opengraph-image.jpg": "opengraph-image.jpg",
  "twitter-image.jpg": "twitter-image.jpg",
};

const appFiles = walk(APP).map((p) => rel(p, APP));
const pageFiles = appFiles.filter((p) => /(^|\/)page\.(tsx|mdx)$/.test(p));
const pages = pageFiles.map((p) => ({ file: p, route: routeOf(p.replace(/\/?page\.\w+$/, "")) }));
const handlers = appFiles
  .filter((p) => /(^|\/)route\.tsx?$/.test(p))
  .map((p) => routeOf(p.replace(/\/?route\.tsx?$/, "")));
const metadata = appFiles.flatMap((p) => {
  const [dir, name] = [p.split("/").slice(0, -1).join("/"), p.split("/").at(-1)!];
  const served = METADATA[name];
  return served ? [`${routeOf(dir)}/${served}`.replace(/^\/\//, "/")] : [];
});
const statics = walk(join(ROOT, "public")).map((p) => `/${rel(p, join(ROOT, "public"))}`);
const redirects = await config.redirects!();
function redirectPattern(source: string): RegExp {
  const body = source
    .split("/")
    .map((s) => {
      if (/^:\w+\*$/.test(s)) return "(?:/.*)?";
      if (/^:\w+$/.test(s)) return "/[^/]+";
      return s ? `/${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : "";
    })
    .join("");
  return new RegExp(`^${body}$`);
}

const destinations: RegExp[] = [
  ...pages.map((p) => patternOf(p.route)),
  ...handlers.map(patternOf),
  ...metadata.map(patternOf),
  ...statics.map(patternOf),
];

function resolves(href: string): boolean {
  const url = new URL(href, "https://ponzu.design");
  const path = url.pathname;
  if (destinations.some((d) => d.test(path))) return true;
  return redirects.some((r) => {
    if (!redirectPattern(r.source).test(path)) return false;
    return !r.has || r.has.every((h) => h.type === "query" && url.searchParams.has(h.key));
  });
}

/** Ids the site's pages and components give elements, for links to a #fragment. */
const ids = new Set(
  [...walk(APP), ...walk(join(ROOT, "components"))]
    .filter((p) => /\.(tsx|mdx)$/.test(p))
    .flatMap((p) => [...readFileSync(p, "utf8").matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!)),
);

/** Every internal link the site writes: literal hrefs and Markdown links, plus the link lists. */
function internalLinks(): { href: string; where: string }[] {
  const sources = [
    ...walk(APP),
    ...walk(join(ROOT, "components")),
    join(ROOT, "mdx-components.tsx"),
  ].filter((p) => /\.(tsx|ts|mdx)$/.test(p) && !/\.test\.tsx?$/.test(p));
  const found = sources.flatMap((p) => {
    const text = readFileSync(p, "utf8");
    const hrefs = [
      ...text.matchAll(/href=["'`](\/(?!\/)[^"'`]*)["'`]/g),
      ...text.matchAll(/\]\((\/(?!\/)[^)\s]*)\)/g),
      // The link constants: export const DOWNLOAD = "/download".
      ...text.matchAll(/export const [A-Z_]+(?::[^=]+)? = "(\/(?!\/)[^"]*)"/g),
      // A page's canonical address: share({ path: "/download" }).
      ...text.matchAll(/share\(\{\s*path:\s*"(\/(?!\/)[^"]*)"/g),
    ];
    return hrefs.map((m) => ({ href: m[1]!, where: rel(p, ROOT) }));
  });
  const lists = [...NAV, ...FOOTER.flatMap((c) => c.links)]
    .filter((l) => l.href.startsWith("/"))
    .map((l) => ({ href: l.href, where: `links.tsx: ${l.label}` }));
  const guides = OSES.map((os) => ({ href: guide(os), where: `guide(${os})` }));
  return [...found, ...lists, ...guides];
}

test("the tree has the pages the site is made of", () => {
  // A sanity check on the reading above, so a broken walk can't pass every other test.
  expect(pages.map((p) => p.route)).toContain("/");
  expect(pages.map((p) => p.route)).toContain("/canvases/[id]");
  expect(metadata).toContain("/sitemap.xml");
  expect(statics).toContain("/badge.svg");
  for (const ok of ["/", "/gh/o/r/a.design", "/canvases/cnv_1", "/designs/des_1", "/badge.svg"])
    expect(resolves(ok)).toBe(true);
  for (const missing of ["/nope", "/share", "/gh", "/canvases", "/download/mac/x"])
    expect(resolves(missing)).toBe(false);
  // A redirect that needs a query covers only links that carry it.
  expect(resolves("/download?start=1")).toBe(true);
});

test("every internal link the site writes lands on a page, a file or a redirect", () => {
  const links = internalLinks();
  expect(links.length).toBeGreaterThan(10);
  const broken = links.filter(({ href }) => !resolves(href));
  expect(broken).toEqual([]);
  const missingAnchors = links.filter(({ href }) => {
    const hash = new URL(href, "https://ponzu.design").hash.slice(1);
    return hash && !ids.has(hash);
  });
  expect(missingAnchors).toEqual([]);
});

test("every redirect lands somewhere that exists", () => {
  const dangling = redirects
    .filter((r) => r.destination.startsWith("/"))
    .filter((r) => !resolves(r.destination.replace(/:\w+\*?/g, "x")));
  expect(dangling).toEqual([]);
});

/** Whether a page, or a layout above it, keeps it out of search. */
function noindex(file: string): boolean {
  const dirs = file.split("/").slice(0, -1);
  const files = [file, ...dirs.map((_, i) => `${dirs.slice(0, i + 1).join("/")}/layout.tsx`)];
  return files.some((f) => {
    const path = join(APP, f);
    return existsSync(path) && /index:\s*false/.test(readFileSync(path, "utf8"));
  });
}

test("the sitemap lists exactly the pages meant for search", () => {
  const listed = sitemap().map((e) => new URL(e.url));
  expect(listed.every((u) => u.origin === "https://ponzu.design")).toBe(true);
  const indexable = pages
    .filter((p) => !p.route.includes("["))
    .filter((p) => !noindex(p.file))
    .map((p) => p.route)
    .sort();
  expect(listed.map((u) => u.pathname).sort()).toEqual(indexable);
});

test("no page is titled just Ponzu, which the layout's template would print twice", () => {
  // app/layout.tsx's template is "%s · Ponzu": a page titled "Ponzu" reads "Ponzu · Ponzu".
  const layout = readFileSync(join(APP, "layout.tsx"), "utf8");
  expect(layout).toContain('template: "%s · Ponzu"');
  const doubled = pageFiles.filter((f) =>
    /\btitle:\s*"Ponzu"/.test(readFileSync(join(APP, f), "utf8")),
  );
  expect(doubled).toEqual([]);
});

test("the retired 1.x pages are landings out of search, or gone", () => {
  const routes = pages.map((p) => p.route);
  for (const route of ["/local", "/gh/[...slug]"]) {
    const page = pages.find((p) => p.route === route);
    expect(page).toBeDefined();
    expect(noindex(page!.file)).toBe(true);
  }
  expect(routes).not.toContain("/share");
  expect(handlers.some((h) => h.startsWith("/og"))).toBe(false);
  expect(handlers).not.toContain("/badge.svg");
  expect(resolves("/open")).toBe(true);
  const og = redirects.find((r) => r.source === "/og/gh/:path*");
  expect(og).toMatchObject({ destination: "/opengraph-image.jpg", statusCode: 302 });
});
