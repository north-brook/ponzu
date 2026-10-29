import type { Metadata } from "next";

/*
 * What every page shares when linked. A page's `openGraph` and `twitter` replace the layout's
 * outright rather than merging, so each page builds its own from these, and none silently loses
 * the card type, site name or image.
 *
 * The image is app/opengraph-image.jpg (and twitter-image.jpg), rendered from /share by
 * scripts/share-image.ts, unless a page brings its own (a design in the viewer does).
 */

/** The site's name and line, used by the layout and the home page. */
export const TITLE = "Ponzu — the open source canvas for your agent";
export const DESCRIPTION =
  "Brands, apps, launch pages, diagrams, dashboards. Your agent draws them in HTML and CSS on your Mac, and you steer with comments.";

export const SHARE_ALT =
  "Ponzu: the open source canvas for your agent. Designs made in Ponzu, from a landing page to brand guidelines and an app screen, recede across a dark canvas.";

const IMAGE = { width: 2400, height: 1260, alt: SHARE_ALT };

/** A page's own card, in place of the site's. */
export interface ShareImage {
  url: string;
  width: number;
  height: number;
  alt: string;
  type: string;
}

export function share({
  path,
  title,
  description,
  xDescription = description,
  image,
}: {
  path: string;
  title: string;
  description: string;
  /** X shows less text under the card, so it can take a shorter line. */
  xDescription?: string;
  /** Shared by Open Graph and X. Without it, the site's card. */
  image?: ShareImage;
}): Pick<Metadata, "alternates" | "openGraph" | "twitter"> {
  return {
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: "Ponzu",
      locale: "en_US",
      url: path,
      title,
      description,
      images: [image ?? { url: "/opengraph-image.jpg", type: "image/jpeg", ...IMAGE }],
    },
    twitter: {
      card: "summary_large_image",
      creator: "@brycebjork",
      title,
      description: xDescription,
      images: [image ?? { url: "/twitter-image.jpg", ...IMAGE }],
    },
  };
}
