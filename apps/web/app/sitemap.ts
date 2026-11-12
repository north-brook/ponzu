import type { MetadataRoute } from "next";
import { LEGAL_DRAFT, LEGAL_PAGES } from "../components/legal-status";

/*
 * Every page meant for search, and nothing else: a page set to noindex stays out. routes.test.ts
 * holds this list to the pages in app/, so a slice that adds a page adds its line here. The legal
 * pages join once LEGAL_STATUS is "in-effect"; while they are drafts they are noindex.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://ponzu.design/", changeFrequency: "weekly", priority: 1 },
    { url: "https://ponzu.design/download", changeFrequency: "weekly", priority: 0.8 },
    { url: "https://ponzu.design/download/mac", changeFrequency: "weekly", priority: 0.7 },
    { url: "https://ponzu.design/download/windows", changeFrequency: "weekly", priority: 0.7 },
    { url: "https://ponzu.design/download/linux", changeFrequency: "weekly", priority: 0.7 },
    { url: "https://ponzu.design/pricing", changeFrequency: "monthly", priority: 0.8 },
    { url: "https://ponzu.design/changelog", changeFrequency: "weekly", priority: 0.6 },
    { url: "https://ponzu.design/privacy/ponzu-1", changeFrequency: "yearly", priority: 0.1 },
    ...(LEGAL_DRAFT ? [] : LEGAL_PAGES).map((path) => ({
      url: `https://ponzu.design${path}`,
      changeFrequency: "yearly" as const,
      priority: 0.2,
    })),
  ];
}
