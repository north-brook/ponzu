import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    // /share is the share card's source, rendered into the preview images; it isn't a page.
    rules: [{ userAgent: "*", allow: "/", disallow: "/share" }],
    sitemap: "https://ponzu.design/sitemap.xml",
  };
}
