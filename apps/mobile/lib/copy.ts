/*
 * The words people read in the phone's setup. They are the Mac's current words for the same
 * steps (apps/studio/src/cloud/setup/{where,claude-step,claude-card}.tsx), so both apps say the
 * same thing; copy.test.ts fails if one of them changes on the Mac and not here. The Claude
 * card's failures are shared outright (@ponzu/client/model/claude-entry).
 */

export const WHERE = {
  title: "Where do you build?",
  body: "Build on your real product, with your team, and ship it as a pull request. Pick where your code lives.",
  setUp: "Set up",
  ready: "Ready",
  suspended: "Suspended on GitHub",
  loading: "Loading your accounts",
  unreachable: "Couldn't reach GitHub.",
  retry: "Try again",
  requested: "Sent to the organization's owners. It shows up here once one approves.",
  failed: "That didn't finish on GitHub. Try again.",
  otherOrganization: "Don't see an organization? Grant access on GitHub",
  continue: "Continue",
} as const;

export const CLAUDE = {
  title: "Connect Claude",
  body: "Claude Code does the work, in the cloud, on your own plan. It picks up where you left off on any device.",
  subscription: "Claude Subscription",
  subscriptionLine: "Pro or Max. Canvases run on your plan.",
  signIn: "Sign in",
  apiKey: "Anthropic API key",
  apiKeyLine: "Pay per token through the Console.",
  addKey: "Add key",
  change: "Change",
  connect: "Connect",
  codeLabel: "Paste the code from claude.ai",
  codeHelp: "claude.ai shows it after you approve.",
  reopen: "Open sign-in again",
  keyLabel: "Paste your Anthropic API key",
  keyPlaceholder: "sk-ant-…",
  keyHelp: "Usage bills to your Anthropic Console account. Ponzu stores the key encrypted.",
} as const;

/** The phone's own: the Mac signs out from its window's menu, the phone from under setup. */
export const SETUP = {
  signOut: "Sign out",
  /** Continue on "Where do you build?" didn't reach the API; the Mac's button just waits. */
  continueFailed: "Couldn't reach Ponzu. Try again.",
  /** For VoiceOver, on the two bars over each step. */
  progress: (step: number, of: number) => `Step ${step} of ${of}`,
} as const;
