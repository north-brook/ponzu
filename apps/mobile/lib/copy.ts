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

/**
 * New canvas and the project picker, in the Mac's create page's words
 * (apps/studio/src/cloud/create/{create-page,composer,repo-picker,model-picker}.tsx and
 * apps/studio/src/cloud/ui/button.tsx); copy.test.ts reads them there.
 */
export const CREATE = {
  inRepo: "Make something in",
  fromScratch: "Make something from",
  placeholder: "Describe what you want to make",
  attach: "Attach",
  send: "Send",
  model: "Model",
  effort: "Effort",
  noEffort: "None for this model",
  chooseRepo: "Choose a repo",
  search: "Search repositories",
  allowMore: "Allow more on GitHub",
  allowRepos: "Allow repositories on GitHub",
  loadingRepos: "Loading repositories",
} as const;

/** Effort levels as the Mac's model picker names them. */
export const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
} as const;

/**
 * What stops a send, as the Mac's Claude dialog says it (apps/studio/src/cloud/dialogs/
 * account-dialogs.tsx), and the phone's own lines for what the Mac doesn't stop on.
 */
export const BLOCKED = {
  connect: "Connect Claude",
  expired: "Your Claude sign-in ran out",
  signedOut: "Claude was signed out",
  connectBody: "Claude Code does the work, on your own plan. Connect it",
  expiredBody: "Sign in to Claude again",
  signedOutBody: "Connect Claude again",
  andSend: "and Ponzu sends this. Your prompt is saved.",
  cancel: "Cancel",
  connectAndSend: "Connect and send",
} as const;

/** The phone's own: a plan at its limit before a send (iPhone design §13, G-M5). */
export const LIMITED = {
  title: "Your Claude plan is at its limit",
  line: (time: string) => `Your Claude plan resets at ${time}. Ponzu sends this then.`,
  sendThen: "Send then",
  cancel: "Cancel",
} as const;

/** The phone's own: a Scratch row's line in the picker, and the project control's label. */
export const PICKER = {
  title: "Project",
  scratch: "Scratch",
  scratchLine: "no repo, kept in Ponzu",
  newCanvas: "New canvas",
  back: "Back",
} as const;

/** The phone's own: the Mac signs out from its window's menu, the phone from under setup. */
export const SETUP = {
  signOut: "Sign out",
  /** Continue on "Where do you build?" didn't reach the API; the Mac's button just waits. */
  continueFailed: "Couldn't reach Ponzu. Try again.",
  /** For VoiceOver, on the two bars over each step. */
  progress: (step: number, of: number) => `Step ${step} of ${of}`,
} as const;
