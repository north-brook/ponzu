import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PostHog's API paths end in a slash; redirecting them breaks ingestion.
  skipTrailingSlashRedirect: true,
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
