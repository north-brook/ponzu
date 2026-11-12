import type { Metadata } from "next";

/*
 * What every page shares when linked. A page's `openGraph` and `twitter` replace the layout's
 * outright rather than merging, so each page builds its own from these, and none silently loses
 * the card type, site name or image.
 *
 * The image is app/opengraph-image.jpg (and twitter-image.jpg, the same picture), unless a page
 * brings its own: the headline beside the hero's product shot (public/product), in dark. Its
 * words are in app/opengraph-image.alt.txt too, which Next reads for the file convention.
 */

/** The site's name and line, used by the layout and the home page. */
export const TITLE = "Ponzu: make it on the canvas, ship it to your repo";
export const DESCRIPTION =
  "Ponzu runs Claude Code in the cloud on your own Claude plan. Steer it with comments on a live canvas, and it ships as a pull request.";

export const SHARE_ALT =
  "Ponzu: make it on the canvas, ship it to your repo. The Ponzu window, with three takes on a shop's hero on the canvas, beside the headline.";

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
