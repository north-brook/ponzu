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
  /** VoiceOver's hint on a pull request's line in the thread. */
  openPullRequest: "Opens the pull request",
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
  noteLabel: "Note",
  secretLabel: (name: string) => `The value of ${name}`,
  /** Under the slot, when someone else's answer closed the ask the person was on. */
  answered: "Someone already answered this.",
  answeredBy: (name: string) => `${name} already answered this.`,
  movedOn: "Claude moved on, so this needs no answer.",
  /** Under the slot, when an answer didn't go: the Mac's words. */
  failed: "Your answer didn't go through. Send it again.",
  offline: "Your answer didn't reach Ponzu. Check your connection and send it again.",
  /** The Mac's sentence, but Settings › Environments is only in Ponzu on the Mac. */
  secretsFull:
    "This repo has no room for another secret. Remove one in Ponzu on your Mac, in Settings › Environments, then send it again.",
  secretReserved:
    "Claude asked for a name Ponzu keeps for itself, so it can't be a secret. Tell Claude to use another name.",
  noRepository: "A Scratch canvas has no repository to keep a secret with.",
  /** The Chat button, while questions wait. */
  chat: (count: number) =>
    count === 1 ? "Chat, Ponzu has a question" : `Chat, Ponzu has ${count} questions`,
} as const;

/**
 * The pull request sheet (components/pr-sheet.tsx, iPhone design §11 and §22). The foot button's
 * labels are the Mac's chrome's (apps/studio/src/cloud/window/next-action.tsx), and the words its
 * tab also says are the Mac's tab's (apps/studio/src/cloud/pr-tab/pull-request-view.tsx);
 * copy.test.ts holds them to it. The rest is the phone's own.
 */
export const PR = {
  /** The foot button, by the API's next action. Create PR is the Mac's (iPhone design §11). */
  actions: {
    ready: "Ready",
    auto_merge: "Auto-merge",
    auto_merge_on: "Auto-merge on",
    fix_checks: "Fix checks",
    resolve: "Resolve",
    update_branch: "Update branch",
    merge: "Merge",
  },
  /** The Mac's tab and chrome say these too. */
  mac: {
    autoMergeOn: "Merges once the checks pass",
    noChecks: "No checks have reported",
    noChecksRan: "No checks ran",
    unreachable: "Couldn't reach GitHub.",
    retry: "Try again",
    openOnGithub: "Open on GitHub",
    checks: "Checks",
    comments: "Comments",
  },
  /** The reviews drill-in's title: approvals and requests for changes together. */
  reviews: "Reviews",
  /** The merge confirmation, a native action sheet (D13). There is never a bypass. */
  confirm: (number: number, base: string) => `Merge #${number} into ${base}?`,
  /** VoiceOver's name for the Merge button: which pull request. */
  mergeLabel: (number: number) => `Merge #${number}`,
  cancel: "Cancel",
  /** Where the repo's rules hold a merge back and the repo has no auto-merge. */
  needsMac: (rule: string) => `This needs the Mac to merge past ${rule}.`,
  /** After Fix checks or Resolve: asked in the chat, once for this commit. */
  asked: "Asked Claude in the chat.",
  status: "Status",
  files: (count: number) => (count === 1 ? "1 file" : `${count} files`),
  /** The status card's rows. */
  checksPassed: (count: number) => (count === 1 ? "1 check passed" : `${count} checks passed`),
  checksFailed: (count: number) => (count === 1 ? "1 check failed" : `${count} checks failed`),
  checksRunning: (done: number, count: number) => `${done} of ${count} checks finished`,
  commentCount: (count: number) => (count === 1 ? "1 comment" : `${count} comments`),
  back: "Back",
  close: "Close",
  /** The subtitle's state words. */
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
  /** A file whose diff the sheet can't show. */
  binary: "A binary file. GitHub shows what changed.",
  tooLarge: "Too large to show here. GitHub shows the whole diff.",
  /** The canvas has no pull request (a link named the sheet before one was opened). */
  none: "This canvas has no pull request yet.",
  /** VoiceOver, on the stack's button and the sheet. */
  button: (number: number) => `Pull request #${number}`,
  loading: "Loading the pull request",
} as const;

/** Pings (docs/mobile.md, "Pings"): the ask after a comment, and Settings › Notifications. */
export const PINGS = {
  /** The sheet after the first comment from this phone (onboarding §4.12). */
  ask: {
    title: "Hear back when Ponzu replies?",
    body: "Your comment is on its way. Ponzu can ping you when it answers, asks a question, or a pull request is ready.",
    turnOn: "Turn on notifications",
    notNow: "Not now",
  },
  /** Settings, in the Mac's words (apps/studio/src/cloud/settings/notifications.tsx). */
  section: "Notifications",
  settings: {
    pingMeWhen: "Ping me when",
    where: "Where",
    pings: "Pings",
    blocked: "Turned off in iOS Settings",
  },
  /** The rows of "Ping me when", as the Mac's. */
  events: [
    { key: "needsYou", title: "Ponzu needs you", line: "A question, a permission, a sign-in" },
    { key: "replies", title: "Ponzu replies to my comment", line: "On canvases I commented on" },
    { key: "prReady", title: "A pull request is ready", line: "Checks passed and it can merge" },
    { key: "teammateComments", title: "A teammate comments", line: "On canvases I own" },
  ],
  /** The phone's own rows. */
  thisIphone: "This iPhone",
  /** iOS hasn't been asked yet: the row that asks. */
  notAsked: "Not turned on yet",
  /** iOS refused: where to turn them on. */
  openSettings: "Open iOS Settings",
} as const;

/**
 * Words the Search tab says (lib/search.ts, components/search-results.tsx; search design §10).
 * Where the Mac's ⌘K says the same thing (apps/studio/src/cloud/sidebar/search.tsx), these are
 * its words, and copy.test.ts checks them against its source. The section labels are the
 * phone's: Threads holds the Mac's Comments and Messages together.
 */
export const SEARCH = {
  placeholder: "Search canvases",
  canvases: "Canvases",
  boards: "Boards",
  threads: "Threads",
  noResults: (query: string) => `No results for “${query}”`,
  failed: "Search isn't answering. Try again in a moment.",
  searching: "Searching…",
  /** Who said it, when it was the canvas's agent, and when the account is gone. */
  agent: "Claude",
  deleted: "Deleted user",
  resolved: "Resolved",
  /** A page found: "Page in Pricing page"; a board: "in Pricing page". */
  pageIn: (canvas: string) => `Page in ${canvas}`,
  boardIn: (canvas: string) => `in ${canvas}`,
  /** The before-typing rows' state, ahead of the age (board 3.2's subtitle grammar). */
  asking: (header: string) => `Asking about ${header}`,
  waiting: "Waiting for you",
  working: "Claude is working",
  settled: "Settled",
  /** A canvas row's needs-you count, to VoiceOver. */
  questions: (n: number) => (n === 1 ? "1 question for you" : `${n} questions for you`),
} as const;

/** What the canvases list says when the workspace has no canvases: where they come from. */
export const EMPTY_CANVASES = "No canvases yet. Canvases you make in Ponzu show up here.";
