/*
 * The companies that process people's data for Ponzu, as data. The /subprocessors table and the
 * privacy policy's summary both render this list (components/legal.tsx), so the two cannot
 * disagree. Each row's facts are tied to code or settings in docs/legal.md ("Subprocessors"); a
 * slice that adds a vendor adds its row here and its line there.
 *
 * `confirm` marks a fact the code cannot answer (a region chosen in a vendor's dashboard): the
 * page shows it as an open question until the founder fills it in.
 */

export interface Subprocessor {
  name: string;
  purpose: string;
  data: string;
  location: string;
  /** In use now, or only once the feature that needs it ships. */
  status: "in-use" | "when-it-ships";
  url: string;
  /** What the founder still has to confirm about this row, shown beside it. */
  confirm?: string;
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
  {
    name: "Vercel, Inc.",
    purpose: "Hosts the API, this website, and the cloud sandboxes where Claude Code runs",
    data: "Requests and logs; repository checkouts, sandbox disks and their snapshots; while a sandbox runs, your Claude credential and the repository's secrets in its memory",
    location: "United States (Washington, D.C. area, iad1)",
    status: "in-use",
    url: "https://vercel.com",
  },
  {
    name: "Neon (Databricks, Inc.)",
    purpose: "Database and realtime updates",
    data: "Accounts, workspaces, canvases, threads, comments, events and usage; tokens and secrets, encrypted",
    location: "United States",
    status: "in-use",
    url: "https://neon.com",
    confirm: "the database's region",
  },
  {
    name: "Cloudflare, Inc.",
    purpose: "Object storage (R2) and delivery of canvas files from ponzu.cloud",
    data: "Canvas files, previews, exports, pictures of comments and pull requests, and checkpoints (the agent's transcript and uncommitted work)",
    location: "United States",
    status: "in-use",
    url: "https://www.cloudflare.com",
    confirm: "the bucket's location and jurisdiction",
  },
  {
    name: "WorkOS, Inc.",
    purpose: "Sign-in and sessions",
    data: "Name, email and GitHub identity",
    location: "United States",
    status: "in-use",
    url: "https://workos.com",
  },
  {
    name: "PostHog, Inc.",
    purpose:
      "Product analytics, session replay, error tracking and AI observability, for the apps, the server and this website",
    data: "Usage events, recordings of app sessions, errors, and model-call metadata",
    location: "United States",
    status: "in-use",
    url: "https://posthog.com",
  },
  {
    name: "Anthropic, PBC",
    purpose: "Suggests prompts to start from for a repository, on Ponzu's own account",
    data: "A repository's description, topics, file layout, README, up to four manifest files and one theme file, and for a small repository the start of up to two other files",
    location: "United States",
    status: "in-use",
    url: "https://www.anthropic.com",
  },
  {
    name: "650 Industries, Inc. (Expo)",
    purpose: "Delivers updates to the iPhone app",
    data: "The phone's platform, the app's runtime version and its update channel, in each check for an update",
    location: "United States",
    status: "in-use",
    url: "https://expo.dev",
  },
  {
    name: "650 Industries, Inc. (Expo)",
    purpose: "Sends pings to iPhones through Expo's push service",
    data: "The phone's push token, and each ping's text and the ids it opens",
    location: "United States",
    status: "when-it-ships",
    url: "https://expo.dev",
  },
  {
    name: "Apple Inc.",
    purpose: "Carries the pings Expo hands it to iPhones (Apple Push Notification service)",
    data: "The phone's push token, and each ping's text",
    location: "United States",
    status: "when-it-ships",
    url: "https://www.apple.com",
  },
  {
    name: "Stripe, Inc.",
    purpose: "Payments",
    data: "The workspace's billing contact and card",
    location: "United States",
    status: "when-it-ships",
    url: "https://stripe.com",
  },
];

/** How a row's status reads on the page. */
export const STATUS_LABEL: Record<Subprocessor["status"], string> = {
  "in-use": "In use",
  "when-it-ships": "When it ships",
};
