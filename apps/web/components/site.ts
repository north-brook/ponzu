/*
 * The site's switches and facts, as committed constants rather than environment variables, so a
 * preview shows exactly what production will and a change is a one-line pull request. The pages
 * that read each one arrive in their own slices (legal, pricing, the changelog, /iphone). This
 * module imports nothing, so links.tsx and every page can read it without a cycle.
 */

/**
 * Ponzu for iPhone's public TestFlight link: the app is in TestFlight only. Null hides the link and
 * the site just says it's in beta.
 */
export const TESTFLIGHT: string | null = "https://testflight.apple.com/join/JXpn8sP5";

/** Whether the legal pages are drafts (noindex, with a notice) or the policy in effect. */
export const LEGAL_STATUS: "draft" | "in-effect" = "draft";
/** The legal pages' effective date, as people read it ("December 1, 2026"), once in effect. */
export const LEGAL_EFFECTIVE: string | null = null;
/** Who makes Ponzu. The registered address is the founder's to give. */
export const ENTITY = { name: "Northbrook PBC", address: null as string | null };
/** Where people write to us. The founder confirms these mailboxes before the site goes live. */
export const CONTACT = {
  privacy: "privacy@ponzu.design",
  security: "security@ponzu.design",
  hello: "hello@ponzu.design",
} as const;
/** Whether billing has started. False: the pricing page says Ponzu is free until it does. */
export const BILLING_LIVE = false;
/** Where /iphone sends people: the TestFlight beta today, the App Store later. */
export const IPHONE_URL_TARGET = TESTFLIGHT;
/** The first desktop version of Ponzu Cloud; the changelog starts there. */
export const FIRST_CLOUD_VERSION = "2.0.0";
/**
 * The first version of the cloud iPhone app (tags `mobile-vX.Y.Z`), where its changelog starts.
 * Ponzu 1's phone app released 0.x. Release Please bumps a 0.x app's minor even for a breaking
 * change, so without a `release-as` the cutover would make the phone 0.13.0, which this hides. The
 * cutover either gives the phone 1.0.0 with `release-as`, or this changes to its first version.
 */
export const FIRST_CLOUD_IPHONE_VERSION = "1.0.0";
