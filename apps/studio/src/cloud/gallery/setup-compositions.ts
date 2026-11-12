/*
 * The guided setup's, Settings' and the blocking dialogs' compositions (setup-boards.tsx draws
 * them), in the shape compositions.ts gives. Settings opens over a design whose canvas and rail
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
  setup("setup-where", "2 · Where do you design", "2-where-do-you-design.html"),
  setup("setup-where-nothing-ready", "Where do you design · nothing ready"),
  setup("setup-where-setting-up", "Where do you design · back from GitHub"),
  setup("setup-where-requested", "Where do you design · requested"),
  setup("setup-where-suspended", "Where do you design · suspended"),
  setup("setup-where-loading", "Where do you design · loading"),
  setup("setup-where-failed", "Where do you design · couldn't reach GitHub"),
  {
    ...setup("setup-where-many", "Where do you design · a dozen accounts, the smallest window"),
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
    id: "settings-plan-breakdown",
    title: "Settings · Plan and usage, by design, with deleted designs and a deleted account",
    ...WINDOW,
  },
  {
    id: "free-credits",
    title: "Free credits used up",
    board: "pricing/free-hours-used-up.html",
    ...WINDOW,
    reference: true,
  },
  { id: "free-credits-member", title: "Free credits used up · a member", ...WINDOW },
  { id: "free-credits-declined", title: "Free credits used up · card declined", ...WINDOW },
  { id: "cap-reached", title: "Monthly cap reached", ...WINDOW },
  { id: "cap-reached-member", title: "Monthly cap reached · a member", ...WINDOW },
  { id: "claude-signed-out", title: "Claude signed out, on send", ...WINDOW },
  { id: "claude-signed-out-code", title: "Claude signed out · paste the code", ...WINDOW },
  { id: "claude-signed-out-key", title: "Claude signed out · key rejected", ...WINDOW },
  { id: "disconnect-claude", title: "Disconnect Claude?", ...WINDOW },
  { id: "delete-account", title: "Delete your account?", ...WINDOW },
];
