/*
 * Where an email points and who it says sent it. The pictures are the same for every recipient
 * and are served by the site (apps/web/public/email, drawn by scripts/email-assets.ts), so an
 * email fetches nothing that could tell anyone it was opened.
 */

/** Every email link goes to the site's handoff pages, never to `ponzu://` directly. */
export const SITE_URL = "https://ponzu.design";

/** The yuzu tile: 96 by 96, shown at 32. Versioned by name if the art ever changes. */
export const TILE_URL = `${SITE_URL}/email/tile-96.png`;

/** Funnel Display 600, the Latin file the apps embed, for the mail apps that load a font. */
export const DISPLAY_FONT_URL = `${SITE_URL}/email/funnel-display-600.woff2`;

/**
 * Who makes Ponzu, as the footer of every email says it. A copy of apps/web's `ENTITY`
 * (components/site.ts); brand.test.ts holds the two equal, so the footer and the site never
 * disagree.
 */
export const COMPANY = {
  name: "Northbrook PBC",
  address: "169 Madison Ave, Suite 2504, New York, NY 10016",
} as const;

/** The footer's last line. */
export const COMPANY_LINE = `${COMPANY.name}, ${COMPANY.address}`;

/** Where a person reaches someone who looks again (a suspension, a question). */
export const HELLO_ADDRESS = "hello@ponzu.design";
