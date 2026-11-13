/*
 * The guided setup's, Settings' and the blocking dialogs' compositions (setup-boards.tsx draws
 * them), in the shape compositions.ts gives. Settings opens over a canvas whose boards and rail
 * this code doesn't draw: those are masked, except where the modal covers them.
 */
import type { Composition, Rect } from "./compositions.ts";

const WINDOW = { width: 1440, height: 900 };
const MAIN: Rect = { x: 300, y: 38, width: 780, height: 856 };
const RAIL: Rect = { x: 1080, y: 38, width: 360, height: 862 };
/** Settings, 760 by 600, centred in the window. */
const MODAL: Rect = { x: 340, y: 150, width: 760, height: 600 };

/** What of `rect` is outside `hole`, as up to four rects. */
function around(rect: Rect, hole: Rect): Rect[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const top = Math.max(rect.y, Math.min(hole.y, bottom));
  const under = Math.min(bottom, Math.max(hole.y + hole.height, rect.y));
  const left = Math.max(rect.x, Math.min(hole.x, right));
  const after = Math.min(right, Math.max(hole.x + hole.width, rect.x));
  return [
    { x: rect.x, y: rect.y, width: rect.width, height: top - rect.y },
    { x: rect.x, y: under, width: rect.width, height: bottom - under },
    { x: rect.x, y: top, width: left - rect.x, height: under - top },
    { x: after, y: top, width: right - after, height: under - top },
  ].filter((r) => r.width > 0 && r.height > 0);
}

const BEHIND_SETTINGS = [...around(MAIN, MODAL), ...around(RAIL, MODAL)];

const setup = (id: string, title: string, board?: string): Composition => ({
  id,
  title,
  ...(board ? { board: `onboarding/${board}`, reference: true } : {}),
  ...WINDOW,
});

const settings = (id: string, title: string, board: string): Composition => ({
  id,
  title,
  board: `settings/${board}`,
  ...WINDOW,
  masks: BEHIND_SETTINGS,
  reference: true,
});

export const SETUP_COMPOSITIONS: Composition[] = [
  setup("setup-sign-in", "1 · Sign in", "1-sign-in.html"),
  setup("setup-sign-in-waiting", "Sign in · waiting for the browser"),
  setup("setup-sign-in-failed", "Sign in · failed"),
  setup("setup-where", "2 · Where do you build", "2-where-do-you-design.html"),
  setup("setup-where-nothing-ready", "Where do you build · nothing ready"),
  setup("setup-where-setting-up", "Where do you build · back from GitHub"),
  setup("setup-where-requested", "Where do you build · requested"),
  setup("setup-where-suspended", "Where do you build · suspended"),
  setup("setup-where-loading", "Where do you build · loading"),
  setup("setup-where-failed", "Where do you build · couldn't reach GitHub"),
  {
    ...setup("setup-where-many", "Where do you build · a dozen accounts, the smallest window"),
    // The smallest window, app-window.tsx's MIN_WINDOW.
    width: 1100,
    height: 640,
  },
  setup("setup-claude", "3 · Connect Claude", "3-connect-claude.html"),
  setup("setup-claude-failed", "Connect Claude · couldn't start"),
  setup("setup-paste-code", "3b · Paste the code", "3b-paste-the-code.html"),
  setup("setup-paste-code-connecting", "Paste the code · connecting"),
  setup("setup-paste-code-wrong", "Paste the code · wrong code"),
  setup("setup-paste-code-expired", "Paste the code · expired"),
  setup("setup-api-key", "Connect Claude · API key"),
  setup("setup-api-key-rejected", "Connect Claude · key rejected"),
  setup("setup-iphone", "4 · Get Ponzu on your iPhone", "4-get-ponzu-on-your-iphone.html"),
  settings("settings-account", "Settings · Account", "account.html"),
  settings("settings-agents", "Settings · Agents", "agents.html"),
  {
    // Not drawn: the plan at its limit in the session and the week on Opus, with a Sonnet week.
    id: "agents-limits",
    title: "Settings · Agents, the plan at its limit",
    ...WINDOW,
    masks: BEHIND_SETTINGS,
  },
  settings("settings-notifications", "Settings · Notifications", "notifications.html"),
  settings("settings-members", "Settings · Members", "members.html"),
  {
    // Not drawn: two people GitHub gives access to who haven't opened Ponzu yet, quieter. The
    // rows are settings-members'; the styles hold who is listed and how quiet they are.
    id: "settings-members-not-joined",
    title: "Settings · Members, some haven't opened Ponzu",
    ...WINDOW,
    masks: BEHIND_SETTINGS,
    reference: "styles",
  },
  settings("settings-github", "Settings · GitHub", "github.html"),
  settings("settings-environments", "Settings · Environments", "environments.html"),
  settings("settings-plan", "Settings · Plan and usage", "plan-and-usage.html"),
  settings("settings-plan-solo", "Settings · Plan and usage, solo", "plan-and-usage-solo.html"),
  {
    // What ships while the API's billing switch is off: credits, one line saying it is free, and
    // no dollars, bar or cap. The mockup has no board for it.
    id: "settings-plan-free",
    title: "Settings · Plan and usage, while billing is off",
    ...WINDOW,
    masks: BEHIND_SETTINGS,
    reference: true,
  },
  {
    id: "settings-plan-breakdown",
    title: "Settings · Plan and usage, by canvas, with deleted canvases and a deleted account",
    ...WINDOW,
  },
  {
    id: "free-credits",
    title: "Free credits used up",
    board: "pricing/free-hours-used-up.html",
    differs:
      "no card fields: the card goes in on Stripe's Checkout page in the browser, which card fields on ponzu-studio:// can't do in live mode (billing plan §8.1)",
    ...WINDOW,
    reference: true,
  },
  {
    // The card goes in on Stripe's page in the browser; the dialog waits for it, the prompt held.
    id: "free-credits-waiting",
    title: "Free credits used up · waiting for the card in the browser",
    ...WINDOW,
    reference: "styles",
  },
  {
    id: "free-credits-cancelled",
    title: "Free credits used up · the card wasn't added",
    ...WINDOW,
  },
  { id: "free-credits-member", title: "Free credits used up · a member", ...WINDOW },
  { id: "cap-reached", title: "Monthly cap reached", ...WINDOW },
  { id: "cap-reached-member", title: "Monthly cap reached · a member", ...WINDOW },
  {
    // Not drawn in the mockup: a payment past its seven days' grace, on send.
    id: "payment-failed",
    title: "Last payment didn't go through",
    ...WINDOW,
    reference: "styles",
  },
  { id: "payment-failed-member", title: "Last payment didn't go through · a member", ...WINDOW },
  {
    // Not drawn: Settings' Add a card, over Plan and usage with billing on and no card.
    id: "add-card",
    title: "Add a card, from Plan and usage",
    ...WINDOW,
    masks: BEHIND_SETTINGS,
    reference: "styles",
  },
  {
    // Not drawn: billing on and no card yet: no cap row, the bar the free credits alone.
    id: "settings-plan-no-card",
    title: "Settings · Plan and usage, billing on, no card yet",
    ...WINDOW,
    masks: BEHIND_SETTINGS,
    reference: "styles",
  },
  {
    // Not drawn: a payment failed, with Pay invoice where Manage in Stripe was.
    id: "settings-plan-past-due",
    title: "Settings · Plan and usage, a payment failed",
    ...WINDOW,
    masks: BEHIND_SETTINGS,
    reference: "styles",
  },
  { id: "claude-signed-out", title: "Claude signed out, on send", ...WINDOW },
  { id: "claude-signed-out-code", title: "Claude signed out · paste the code", ...WINDOW },
  { id: "claude-signed-out-key", title: "Claude signed out · key rejected", ...WINDOW },
  { id: "disconnect-claude", title: "Disconnect Claude?", ...WINDOW },
  { id: "delete-account", title: "Delete your account?", ...WINDOW },
];
