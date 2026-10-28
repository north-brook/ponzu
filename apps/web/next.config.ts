import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PostHog's API paths end in a slash; redirecting them breaks ingestion.
  skipTrailingSlashRedirect: true,
  // Source maps, so PostHog can turn errors' minified stack traces back into our source (the source
  // is on GitHub anyway). It fetches them itself, but only once the Vercel project's Protected Source
  // Maps is off; until then .map files need a Vercel login and traces stay minified.
  productionBrowserSourceMaps: true,
  // The share cards read their fonts from disk (app/gh/og.tsx).
  outputFileTracingIncludes: { "/og/gh/[...slug]": ["./assets/og/*.ttf"] },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
    ];
  },
  // Agents' links to a design on the person's Mac were /open#…: the browser keeps the # across
  // the redirect.
  async redirects() {
    return [{ source: "/open", destination: "/local", permanent: true }];
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

export default nextConfig;
