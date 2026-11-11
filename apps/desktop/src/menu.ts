import { app, Menu, shell } from "electron";
import type { MenuCommand } from "./bridge.ts";

/*
 * The app's menus. What the studio carries out (a new design, Settings) goes to it as a
 * command, so a shortcut does the same thing from anywhere in the window; signing out and
 * updating are the main process's own.
 */

export interface MenuActions {
  command(command: MenuCommand): void;
  /** Null in a build that doesn't update itself (Ponzu Dev): the menus leave the item out. */
  checkForUpdates: (() => void) | null;
  signOut(): void;
  /** Whether View has Toggle Developer Tools: development and test builds only. */
  devTools: boolean;
}

const SIGN_OUT = "sign-out";

export function buildMenu(actions: MenuActions): void {
  const mac = process.platform === "darwin";
  const account: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      click: () => actions.command("settings"),
    },
    { type: "separator" },
    { id: SIGN_OUT, label: "Sign Out", enabled: false, click: () => actions.signOut() },
  ];
  const checkForUpdates = actions.checkForUpdates;
  const update: Electron.MenuItemConstructorOptions[] = checkForUpdates
    ? [{ label: "Check for Updates…", click: () => checkForUpdates() }]
    : [];
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              ...update,
              { type: "separator" as const },
              ...account,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Design",
          accelerator: "CmdOrCtrl+N",
          click: () => actions.command("new-design"),
        },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        // The studio takes these keys itself, from anywhere in the window (text fields too), and
        // the page has a key before the menu does; a click here reaches it as a command. It
        // drops a command its own shortcut has just run, so one press never toggles twice.
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => actions.command("toggle-sidebar"),
        },
        {
          label: "Toggle Thread",
          accelerator: "CmdOrCtrl+J",
          click: () => actions.command("toggle-thread"),
        },
        { type: "separator" },
        { role: "reload" },
        ...(actions.devTools ? [{ role: "toggleDevTools" as const }] : []),
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "ponzu.design", click: () => void shell.openExternal("https://ponzu.design") },
        // Off the Mac there's no app menu to hold these.
        ...(mac ? [] : [{ type: "separator" as const }, ...update, ...account]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Sign Out only means something while someone is signed in. */
export function setSignedIn(signedIn: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(SIGN_OUT);
  if (item) item.enabled = signedIn;
}
