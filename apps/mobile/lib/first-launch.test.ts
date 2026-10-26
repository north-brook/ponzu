import { expect, test } from "bun:test";
import { type FirstLaunchUpdates, firstLaunch } from "./first-launch";

const embedded = { embedded: true, enabled: true };

function updates(found: {
  available?: boolean;
  isNew?: boolean;
  checkFails?: boolean;
  reloadFails?: boolean;
  reloadHangs?: boolean;
  never?: boolean;
}) {
  const calls: string[] = [];
  const api: FirstLaunchUpdates = {
    check: () => {
      calls.push("check");
      if (found.never) return new Promise(() => undefined);
      return found.checkFails
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ isAvailable: found.available ?? false });
    },
    fetch: () => {
      calls.push("fetch");
      return Promise.resolve({ isNew: found.isNew ?? true });
    },
    reload: () => {
      calls.push("reload");
      if (found.reloadHangs) return new Promise(() => undefined);
      return found.reloadFails ? Promise.reject(new Error("no runtime")) : Promise.resolve();
    },
  };
  return { api, calls };
}

test("a new install restarts into the current release before showing anything", async () => {
  const { api, calls } = updates({ available: true });
  expect(await firstLaunch(embedded, api)).toBe("restarting");
  expect(calls).toEqual(["check", "fetch", "reload"]);
});

test("a phone already on a downloaded release launches straight in", async () => {
  const { api, calls } = updates({ available: true });
  expect(await firstLaunch({ embedded: false, enabled: true }, api)).toBe("current");
  expect(await firstLaunch({ embedded: true, enabled: false }, api)).toBe("current");
  expect(calls).toEqual([]);
});

test("a build whose embedded release is the newest goes on with it", async () => {
  const none = updates({ available: false });
  expect(await firstLaunch(embedded, none.api)).toBe("latest");
  expect(none.calls).toEqual(["check"]);
  const same = updates({ available: true, isNew: false });
  expect(await firstLaunch(embedded, same.api)).toBe("latest");
  expect(same.calls).toEqual(["check", "fetch"]);
});

test("offline or slow, the splash waits a bounded time, then goes on", async () => {
  const offline = updates({ checkFails: true });
  expect(await firstLaunch(embedded, offline.api)).toBe("failed");
  const slow = updates({ never: true });
  const began = Date.now();
  expect(await firstLaunch(embedded, slow.api, 20)).toBe("timed_out");
  expect(Date.now() - began).toBeLessThan(1000);
  expect(slow.calls).toEqual(["check"]);
});

test("a restart that cannot happen goes on with the embedded release", async () => {
  const { api } = updates({ available: true, reloadFails: true });
  expect(await firstLaunch(embedded, api)).toBe("failed");
});

test("a restart that never lands lets the splash go after a bounded wait", async () => {
  const { api, calls } = updates({ available: true, reloadHangs: true });
  const began = Date.now();
  expect(await firstLaunch(embedded, api, 1000, 20)).toBe("timed_out");
  expect(Date.now() - began).toBeLessThan(1000);
  expect(calls).toEqual(["check", "fetch", "reload"]);
});
