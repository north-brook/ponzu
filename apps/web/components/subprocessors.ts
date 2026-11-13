/*
 * The companies that process people's data for Ponzu, as data. The /subprocessors table and the
 * privacy policy's summary both render this list (components/legal.tsx), so the two cannot
 * disagree. Each row's facts are tied to code or settings in docs/legal.md ("Subprocessors"); a
 * slice that adds a vendor adds its row here and its line there.
 *
 * `location` says only what is known: the region we chose where we chose one (Vercel, Neon,
 * PostHog), and otherwise that the vendor decides. `confirm` marks a fact the code cannot answer:
 * the page shows it as an open question, and legal.test.ts refuses one while the pages are in
 * effect.
 */

export interface Subprocessor {
  name: string;
  purpose: string;
  data: string;
  location: string;
  /** In use now, or only once the feature that needs it is switched on. */
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
    location: "United States (Washington, D.C., iad1)",
    status: "in-use",
    url: "https://vercel.com",
  },
  {
    name: "Neon (Databricks, Inc.)",
    purpose: "Database and realtime updates",
    data: "Accounts, workspaces, canvases, threads, comments, notifications, events and usage; tokens and secrets, encrypted; and, for live updates, the IP address of each device connected to it",
    location: "United States (AWS us-east-1, N. Virginia)",
    status: "in-use",
    url: "https://neon.com",
  },
  {
    name: "Cloudflare, Inc.",
    purpose: "Object storage (R2) and delivery of canvas files from ponzu.cloud",
    data: "Canvas files, previews, exports, pictures of comments and pull requests, and, in a bucket of their own, checkpoints (the agent's transcript and uncommitted work)",
    location: "Delivered through Cloudflare's network worldwide",
    status: "in-use",
    url: "https://www.cloudflare.com",
  },
  {
    name: "WorkOS, Inc.",
    purpose: "Sign-in and sessions",
    data: "Name, email and GitHub identity; the GitHub token each sign-in produces, as it passes through; the IP address and browser of each sign-in",
    location: "Where WorkOS runs its service",
    status: "in-use",
    url: "https://workos.com",
  },
  {
    name: "PostHog, Inc.",
    purpose:
      "Product analytics, session replay, error tracking and AI observability, for the desktop app, the server and this website",
    data: "Usage events, recordings of desktop app sessions, errors, model-call metadata, and the IP address of events sent from your device",
    location: "United States (PostHog Cloud US)",
    status: "in-use",
    url: "https://posthog.com",
  },
  {
    name: "Anthropic, PBC",
    purpose: "Suggests prompts to start from for a repository, on Ponzu's own account",
    data: "A repository's description, topics, file layout, README, up to four manifest files and one theme file, and for a small repository the start of up to two other files",
    location: "Where Anthropic runs its service",
    status: "in-use",
    url: "https://www.anthropic.com",
  },
  {
    name: "650 Industries, Inc. (Expo)",
    purpose: "Delivers updates to the iPhone app",
    data: "The phone's IP address and platform, the app's runtime version and its update channel, and whatever else Expo's update library sends, in each check for an update",
    location: "Where Expo runs its service",
    status: "in-use",
    url: "https://expo.dev",
  },
  {
    name: "650 Industries, Inc. (Expo)",
    purpose: "Sends pings to iPhones through Expo's push service",
    data: "The phone's push token, and each ping's text and the ids it opens",
    location: "Where Expo runs its service",
    status: "when-it-ships",
    url: "https://expo.dev",
  },
  {
    name: "Apple Inc.",
    purpose: "Carries the pings Expo hands it to iPhones (Apple Push Notification service)",
    data: "The phone's push token, and each ping's text",
    location: "Where Apple runs its service",
    status: "when-it-ships",
    url: "https://www.apple.com",
  },
  {
    name: "Resend",
    purpose: "Sends the daily email of notifications, to people who turn it on",
    data: "Your email address, and the email: your canvases' names and Ponzu's own sentences about them",
    location: "Where Resend runs its service",
    status: "when-it-ships",
    url: "https://resend.com",
  },
  {
    name: "Stripe, Inc.",
    purpose: "Payments",
    data: "The workspace's billing contact and card",
    location: "Where Stripe runs its service",
    status: "when-it-ships",
    url: "https://stripe.com",
  },
];

/** How a row's status reads on the page. */
export const STATUS_LABEL: Record<Subprocessor["status"], string> = {
  "in-use": "In use",
  "when-it-ships": "Not in use yet",
};
