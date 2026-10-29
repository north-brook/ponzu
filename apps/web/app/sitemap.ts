import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://ponzu.design/", changeFrequency: "weekly", priority: 1 },
    { url: "https://ponzu.design/download", changeFrequency: "weekly", priority: 0.8 },
    { url: "https://ponzu.design/download/mac", changeFrequency: "weekly", priority: 0.7 },
    { url: "https://ponzu.design/download/windows", changeFrequency: "weekly", priority: 0.7 },
    { url: "https://ponzu.design/download/linux", changeFrequency: "weekly", priority: 0.7 },
    { url: "https://ponzu.design/privacy", changeFrequency: "yearly", priority: 0.2 },
  ];
}
