/*
 * The words people read in the phone's setup. They are the Mac's current words for the same
 * steps (apps/studio/src/cloud/setup/{where,claude-step,claude-card}.tsx), so both apps say the
 * same thing; copy.test.ts fails if one of them changes on the Mac and not here. The Claude
 * card's failures are shared outright (@ponzu/client/model/claude-entry). The canvas screen's
 * and the comment flow's words are the phone's own, at the foot.
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
  /** VoiceOver's name for the cross on a picture waiting to go with the prompt. */
  remove: (name: string) => `Remove ${name}`,
} as const;

/** The phone's own: the Mac signs out from its window's menu, the phone from under setup. */
export const SETUP = {
  signOut: "Sign out",
  /** Continue on "Where do you build?" didn't reach the API; the Mac's button just waits. */
  continueFailed: "Couldn't reach Ponzu. Try again.",
  /** For VoiceOver, on the two bars over each step. */
  progress: (step: number, of: number) => `Step ${step} of ${of}`,
} as const;

/** Words the canvas screen says (lib/canvas/status.ts). */
export const CANVAS_WORDS = {
  offline: "You're offline. This is the last copy Ponzu had.",
  unreachable: "Can't reach Ponzu. Trying again.",
  gone: "That canvas isn't available to you.",
  waking: "Waking up",
  readOnly: (repo: string) =>
    `You can look at this canvas. Steering it takes push access to ${repo}.`,
} as const;

/** Words the comment flow says (lib/canvas/comments.ts). */
export const COMMENT_WORDS = {
  /** A comment made while the phone can't reach Ponzu: in the canvas here, sent later. */
  queued: "Saved here. Ponzu sends it when you're back online.",
  /** The Comment button was pressed: the next tap on the canvas drops the pin. */
  place: "Tap where your comment goes",
  /** A refusal the API gave no words for. */
  refused: "Ponzu couldn't keep that comment. Try again.",
  /** A canvas with no repo (Scratch) the person can only look at. */
  readOnlyScratch: "You can look at this canvas.",
} as const;

/** Words the chat sheet says (components/chat-sheet.tsx, lib/chat/lines.ts; iPhone design §22). */
export const CHAT = {
  /** The field, empty. */
  placeholder: "Steer, or ask more",
  /** Under the field, after a send that didn't go: tapping it sends again. */
  sendFailed: "Couldn't send. Tap to try again.",
  /** Under the field, after Stop didn't reach Ponzu. */
  stopFailed: "Couldn't stop it. Try again.",
  /** After a billing blocker's first sentence: what the canvas does, and nothing about paying. */
  waits: "This canvas waits.",
  /** The thread before anything is in it. */
  empty: "Nothing here yet. Say what you want, and Ponzu gets to work.",
  /** The thread couldn't be read and nothing of it is kept here. */
  unreachable: "Can't reach Ponzu. Trying again.",
  attach: "Attach",
  stop: "Stop",
  send: "Send",
  /** VoiceOver's name for the cross on a picture waiting to go with the message. */
  remove: (name: string) => `Remove ${name}`,
  /** VoiceOver's name for a comment's picture in the thread, which goes to the pin. */
  openComment: (place: string) => `Open the comment on ${place}`,
} as const;

/**
 * Needs you (iPhone design §10 and §22): what the agent asks, in the chat's composer slot. The
 * card's words are the Mac's (apps/studio/src/cloud/needs-you/needs-you.tsx); copy.test.ts holds
 * them to it. The lines under the slot are the phone's own.
 */
export const NEEDS_YOU = {
  /** Each kind's header; a question's is its own. */
  plan: "Plan",
  permission: "Permission",
  secret: "Secret",
  link: "Over to you",
  /** After a multi-select question's words. */
  chooseAny: "Choose any.",
  /** The note's field, by kind. */
  questionNote: "Add a note, or answer in words",
  planNote: "Add a note, or say what to change",
  note: "Add a note",
  secretField: "Paste the value",
  /** A plan's first paragraph shows; this opens the rest in the sheet. */
  readPlan: "Read the plan",
  secretLead: (name: string) => `Claude needs ${name} to go on.`,
  secretKept: (repo: string | null) =>
    repo
      ? `Kept with ${repo}'s secrets for its canvases. It never goes in the thread.`
      : "Kept for this canvas only. It never goes in the thread.",
  open: (host: string) => `Open ${host}`,
  opened: "Opened. Send when you're done there.",
  notNow: "Not now",
  notWeb: "Not a web address, so Ponzu won't open it:",
  /** VoiceOver: the card, and the pager's steps. */
  card: (header: string) => `Ponzu needs you: ${header}`,
  previous: "Previous",
  next: "Next",
  of: (at: number, count: number) => `${at} of ${count}`,
  send: "Send",
  /** Under the slot, when someone else's answer closed the ask the person was on. */
  answered: "Someone already answered this.",
  answeredBy: (name: string) => `${name} already answered this.`,
  movedOn: "Claude moved on, so this needs no answer.",
  /** Under the slot, when an answer didn't go: the Mac's words. */
  failed: "Your answer didn't go through. Send it again.",
  offline: "Your answer didn't reach Ponzu. Check your connection and send it again.",
  secretsFull:
    "This repo has no room for another secret. Remove one in Settings › Environments, then send it again.",
  secretReserved:
    "Claude asked for a name Ponzu keeps for itself, so it can't be a secret. Tell Claude to use another name.",
  noRepository: "A Scratch canvas has no repository to keep a secret with.",
  /** The Chat button, while questions wait. */
  chat: (count: number) =>
    count === 1 ? "Chat, Ponzu has a question" : `Chat, Ponzu has ${count} questions`,
} as const;

/** What the canvases list says when the workspace has no canvases: where they come from. */
export const EMPTY_CANVASES = "No canvases yet. Canvases you make in Ponzu show up here.";
