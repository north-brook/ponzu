import type { MetadataRoute } from "next";

/*
 * Everything may be crawled. The pages kept out of search (the canvas link page, the retired
 * /local and /gh landings) say so themselves with noindex, which a crawler can only read if it is
 * allowed to fetch them.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: "https://ponzu.design/sitemap.xml",
  };
}
