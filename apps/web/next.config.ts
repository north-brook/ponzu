import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
