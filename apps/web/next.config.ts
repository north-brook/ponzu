import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PostHog's API paths end in a slash; redirecting them breaks ingestion.
  skipTrailingSlashRedirect: true,
  // Source maps, so PostHog can turn errors' minified stack traces back into our source (the source
  // is on GitHub anyway). It fetches them itself, but only once the Vercel project's Protected Source
  // Maps is off; until then .map files need a Vercel login and traces stay minified.
  productionBrowserSourceMaps: true,
  // .mdx files are pages too (the legal pages and the docs), through @next/mdx and
  // mdx-components.tsx.
  pageExtensions: ["ts", "tsx", "mdx"],
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
      // RFC 9116 names /.well-known/security.txt; app/security.txt/route.ts serves the file.
      { source: "/.well-known/security.txt", destination: "/security.txt" },
    ];
  },
  // Agents' links to a design on the person's Mac were /open#…: the browser keeps the # across
  // the redirect.
  async redirects() {
    return [
      { source: "/open", destination: "/local", permanent: true },
      // A canvas's link was /designs/<id> before canvases had their name. Pull requests and
      // threads already written keep those links for good, so they still open. The query
      // (?page=, ?artboard=, ?app=) carries over.
      { source: "/designs/:id", destination: "/canvases/:id", permanent: true },
      // Ponzu 1's GitHub viewer drew a share card for each of its pages here. The viewer has
      // retired (app/gh is a landing), so a card still linked from a chat or a post falls back to
      // the site's own. A 302 says so without telling caches the old address is gone for good.
      { source: "/og/gh/:path*", destination: "/opengraph-image.jpg", statusCode: 302 },
      // /download was the Mac's install steps, and every Download button sent ?start=1 there.
      // Those links (in apps and agents' messages) still mean the Mac. The query carries over.
      {
        source: "/download",
        has: [{ type: "query", key: "start" }],
        destination: "/download/mac",
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:file*.:ext(png|svg|webp)",
        headers: [{ key: "cache-control", value: "public, max-age=86400" }],
      },
    ];
  },
};

// GitHub-flavoured Markdown, for the tables the legal pages and docs use. Named as a string, as
// Turbopack (the default bundler) requires of MDX plugins.
export default createMDX({ options: { remarkPlugins: ["remark-gfm"] } })(nextConfig);
