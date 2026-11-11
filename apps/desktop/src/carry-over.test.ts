import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  adoptCheckoutFolder,
  awaitingSignIn,
  carryOver,
  lockHeld,
  RECORD,
  signedInOnce,
} from "./carry-over.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function machine(running: string[] = []) {
  const appData = mkdtempSync(join(tmpdir(), "ponzu-carry-"));
  homes.push(appData);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(appData, path)), { recursive: true });
    writeFileSync(join(appData, path), text);
  };
  const read = (path: string) => readFileSync(join(appData, path), "utf8");
  const host = {
    appData,
    running: (folder: string) => running.some((name) => join(appData, name) === folder),
    now: () => new Date("2026-11-11T12:00:00Z"),
  };
  return { appData, put, read, host };
}

/** What Ponzu Preview left: its sealed session, its window state and Chromium's profile. */
function preview(m: ReturnType<typeof machine>) {
  m.put("Ponzu Preview/session.bin", "sealed by Ponzu Preview Safe Storage");
  m.put("Ponzu Preview/Local Storage/leveldb/000003.log", "ponzu.ui.usr_1");
  m.put("Ponzu Preview/Local Storage/leveldb/LOCK", "");
  m.put("Ponzu Preview/Preferences", "{}");
}

test("Ponzu Dev's first launch copies Ponzu Preview's window state, never its session, and leaves it be", () => {
  const m = machine();
  preview(m);
  const record = carryOver(m.host);
  expect(record).toEqual({
    at: "2026-11-11T12:00:00.000Z",
    checkoutFolder: null,
    windowState: "copied",
    awaitingSignIn: true,
  });
  expect(m.read("Ponzu Dev/Local Storage/leveldb/000003.log")).toBe("ponzu.ui.usr_1");
  // The session is sealed by a keychain item only Ponzu Preview can open: it stays behind.
  expect(existsSync(join(m.appData, "Ponzu Dev/session.bin"))).toBe(false);
  expect(existsSync(join(m.appData, "Ponzu Dev/Local Storage/leveldb/LOCK"))).toBe(false);
  expect(readdirSync(join(m.appData, "Ponzu Dev")).sort()).toEqual(["Local Storage", RECORD]);
  // Ponzu Preview's folder is as it was.
  expect(m.read("Ponzu Preview/session.bin")).toBe("sealed by Ponzu Preview Safe Storage");
  expect(m.read("Ponzu Preview/Local Storage/leveldb/000003.log")).toBe("ponzu.ui.usr_1");

  // Once: a later launch does nothing, even with Ponzu Preview's state changed since.
  m.put("Ponzu Preview/Local Storage/leveldb/000003.log", "newer");
  expect(carryOver(m.host)).toBeNull();
  expect(m.read("Ponzu Dev/Local Storage/leveldb/000003.log")).toBe("ponzu.ui.usr_1");
});

test("the copied window state is kept while signed out, until the first sign-in", () => {
  const m = machine();
  preview(m);
  carryOver(m.host);
  const folder = join(m.appData, "Ponzu Dev");
  expect(awaitingSignIn(folder)).toBe(true);
  signedInOnce(folder);
  expect(awaitingSignIn(folder)).toBe(false);
  expect(JSON.parse(m.read(`Ponzu Dev/${RECORD}`)).windowState).toBe("copied");
  // An app with no record, or one that copied nothing, keeps nothing past a signed-out launch.
  expect(awaitingSignIn(join(m.appData, "Ponzu"))).toBe(false);
});

test("a running Ponzu Preview's state isn't copied mid-write; the launch says so and starts new", () => {
  const m = machine(["Ponzu Preview"]);
  preview(m);
  expect(carryOver(m.host)).toMatchObject({ windowState: "running", awaitingSignIn: false });
  expect(existsSync(join(m.appData, "Ponzu Dev/Local Storage"))).toBe(false);
});

test("with no Ponzu Preview, the first launch only marks the folder as Ponzu Dev's", () => {
  const m = machine();
  expect(carryOver(m.host)).toMatchObject({ windowState: "none", checkoutFolder: null });
  expect(readdirSync(join(m.appData, "Ponzu Dev"))).toEqual([RECORD]);
});

test("a checkout run's old Ponzu Dev folder becomes Ponzu Local's, whichever app starts first", () => {
  // Ponzu Dev first: the checkout's folder, sealed by a keychain item Electron.app made, moves.
  const first = machine();
  first.put("Ponzu Dev/session.bin", "the checkout's");
  first.put("Ponzu Dev/Local Storage/leveldb/000003.log", "the checkout's window");
  preview(first);
  expect(carryOver(first.host)).toMatchObject({
    checkoutFolder: join(first.appData, "Ponzu Local"),
    windowState: "copied",
  });
  expect(first.read("Ponzu Local/session.bin")).toBe("the checkout's");
  expect(first.read("Ponzu Local/Local Storage/leveldb/000003.log")).toBe("the checkout's window");
  expect(first.read("Ponzu Dev/Local Storage/leveldb/000003.log")).toBe("ponzu.ui.usr_1");
  // Ponzu Local finds its folder in place, and Ponzu Dev's is its own.
  expect(adoptCheckoutFolder(first.host)).toBeNull();

  // Ponzu Local first: it takes the folder back itself.
  const second = machine();
  second.put("Ponzu Dev/session.bin", "the checkout's");
  expect(adoptCheckoutFolder(second.host)).toBe(join(second.appData, "Ponzu Local"));
  expect(second.read("Ponzu Local/session.bin")).toBe("the checkout's");
  expect(carryOver(second.host)).toMatchObject({ checkoutFolder: null });

  // Ponzu Local's folder already taken: the old one goes beside it, never over it.
  const third = machine();
  third.put("Ponzu Local/session.bin", "Ponzu Local's own");
  third.put("Ponzu Dev/session.bin", "the checkout's");
  expect(adoptCheckoutFolder(third.host)).toBeNull();
  expect(carryOver(third.host)?.checkoutFolder).toBe(join(third.appData, "Ponzu Local 2"));
  expect(third.read("Ponzu Local/session.bin")).toBe("Ponzu Local's own");
  expect(third.read("Ponzu Local 2/session.bin")).toBe("the checkout's");
});

test("a checkout run still open under the old name is left alone, and asked about again later", () => {
  const m = machine(["Ponzu Dev"]);
  m.put("Ponzu Dev/session.bin", "the checkout's");
  expect(adoptCheckoutFolder(m.host)).toBeNull();
  expect(carryOver(m.host)).toBeNull();
  expect(m.read("Ponzu Dev/session.bin")).toBe("the checkout's");
  expect(existsSync(join(m.appData, `Ponzu Dev/${RECORD}`))).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "a lock is held while the process it names is alive",
  () => {
    const m = machine();
    const folder = join(m.appData, "Ponzu Preview");
    mkdirSync(folder);
    expect(lockHeld(folder)).toBe(false);
    symlinkSync(`host-${process.pid}`, join(folder, "SingletonLock"));
    expect(lockHeld(folder)).toBe(true);
    rmSync(join(folder, "SingletonLock"));
    // A pid no process has: a lock left by a crash.
    symlinkSync("host-2147483646", join(folder, "SingletonLock"));
    expect(lockHeld(folder)).toBe(false);
  },
);
