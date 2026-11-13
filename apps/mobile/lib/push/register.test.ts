import { expect, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import type { PingPermission } from "./ask";
import { createRegistrar, type DeviceRoutes, deviceStore, type PushNative } from "./register";

const TOKEN = "ExponentPushToken[abcdefgh12345678]";
const NEW_TOKEN = "ExponentPushToken[zyxwvuts87654321]";
const INSTALL = "0123456789abcdef0123456789abcdef";

/** iOS and the API as fakes, and every call made, in order. */
function world(opts: {
  permission?: PingPermission;
  answer?: PingPermission;
  environment?: "development" | "production" | null;
  tokenFails?: number;
  register?: () => Promise<{ device: { id: string } }>;
  update?: () => Promise<{ device: { id: string } }>;
  active?: () => Promise<void>;
  kept?: Map<string, string>;
}) {
  const calls: string[] = [];
  let permission = opts.permission ?? "granted";
  let token = TOKEN;
  let fails = opts.tokenFails ?? 0;
  let tokenListener: (() => void) | null = null;
  const native: PushNative = {
    permission: async () => permission,
    requestPermission: async () => {
      calls.push("prompt");
      permission = opts.answer ?? "granted";
      return permission;
    },
    expoToken: async () => {
      if (fails > 0) {
        fails--;
        calls.push("token:failed");
        throw new Error("no APNs yet");
      }
      calls.push("token");
      return token;
    },
    environment: async () => (opts.environment === undefined ? "production" : opts.environment),
    onTokenChange: (listener) => {
      tokenListener = listener;
      return () => {
        tokenListener = null;
      };
    },
  };
  const devices: DeviceRoutes = {
    register: async (body) => {
      calls.push(`register:${JSON.stringify(body)}`);
      return opts.register ? opts.register() : { device: { id: "dev_1" } };
    },
    update: async (id, changes) => {
      calls.push(`update:${id}:${JSON.stringify(changes)}`);
      return opts.update ? opts.update() : { device: { id } };
    },
    active: async (id) => {
      calls.push(`active:${id}`);
      if (opts.active) await opts.active();
    },
  };
  const kept = opts.kept ?? new Map<string, string>();
  const store = deviceStore(
    {
      getItem: async (key) => kept.get(key) ?? null,
      setItem: async (key, value) => {
        kept.set(key, value);
      },
      removeItem: async (key) => {
        kept.delete(key);
      },
    },
    "ponzu.device",
  );
  const conflicts: number[] = [];
  const waits: number[] = [];
  const registrar = (userId = "usr_maya") =>
    createRegistrar({
      native,
      devices,
      store,
      userId,
      installId: async () => INSTALL,
      name: "iPhone 16 Pro",
      appVersion: "1.1.0+embedded",
      onConflict: () => conflicts.push(1),
      wait: async (ms) => {
        waits.push(ms);
      },
    });
  return {
    calls,
    kept,
    store,
    conflicts,
    waits,
    registrar,
    setPermission: (p: PingPermission) => {
      permission = p;
    },
    newToken: () => {
      token = NEW_TOKEN;
      tokenListener?.();
    },
  };
}

const registered = (blocked = false, environment = "production") =>
  `register:${JSON.stringify({
    platform: "ios",
    pushToken: TOKEN,
    pushEnvironment: environment,
    installId: INSTALL,
    name: "iPhone 16 Pro",
    appVersion: "1.1.0+embedded",
    blocked,
  })}`;

test("allowed: the Expo token and APNs environment register this install, and its id is kept for the person", async () => {
  const w = world({ environment: "development" });
  expect(await w.registrar().sync()).toBe("registered");
  expect(w.calls).toEqual(["token", registered(false, "development")]);
  expect(await w.store.read("usr_maya")).toBe("dev_1");
  // Kept with whose it is: someone else signed in here finds no device of theirs.
  expect(await w.store.read("usr_sam")).toBeNull();
});

test("refused in iOS: a registered device is told it's blocked, and none is made", async () => {
  const w = world({ permission: "denied" });
  expect(await w.registrar().sync()).toBe("blocked");
  expect(w.calls).toEqual([]);

  await w.store.write("usr_maya", "dev_1");
  expect(await w.registrar().sync()).toBe("blocked");
  expect(w.calls).toEqual(['update:dev_1:{"blocked":true}']);
});

test("not asked yet: nothing is sent", async () => {
  const w = world({ permission: "undetermined" });
  expect(await w.registrar().sync()).toBe("undetermined");
  expect(w.calls).toEqual([]);
});

test("the simulator (no APNs environment) is skipped: no token asked, nothing registered", async () => {
  const w = world({ environment: null });
  expect(await w.registrar().sync()).toBe("simulator");
  expect(w.calls).toEqual([]);
  expect(w.kept.size).toBe(0);
});

test("a token that isn't ready is tried three times, waiting longer each time", async () => {
  const w = world({ tokenFails: 2 });
  expect(await w.registrar().sync()).toBe("registered");
  expect(w.calls).toEqual(["token:failed", "token:failed", "token", registered()]);
  expect(w.waits).toEqual([1000, 2000]);

  const never = world({ tokenFails: 3 });
  expect(await never.registrar().sync()).toBe("failed");
  expect(never.calls).toEqual(["token:failed", "token:failed", "token:failed"]);
});

test("a new token from iOS patches the device with Expo's new token", async () => {
  const w = world({});
  const registrar = w.registrar();
  await registrar.sync();
  w.calls.length = 0;
  await registrar.tokenChanged();
  expect(w.calls).toEqual(["token", `update:dev_1:${JSON.stringify({ pushToken: TOKEN })}`]);
  // Before any device, a new token waits for the next registration.
  const fresh = world({});
  await fresh.registrar().tokenChanged();
  expect(fresh.calls).toEqual([]);
});

test("409 push_token_taken is told once, with no token, and not retried", async () => {
  const taken = () => Promise.reject(new ApiError(409, "push_token_taken", "Another account."));
  const w = world({ register: taken, update: taken });
  const registrar = w.registrar();
  expect(await registrar.sync()).toBe("conflict");
  expect(await registrar.sync()).toBe("conflict");
  await w.store.write("usr_maya", "dev_9");
  await registrar.tokenChanged();
  expect(w.conflicts).toEqual([1]);
  // Each sync asked once; nothing was tried again inside it.
  expect(w.calls.filter((c) => c.startsWith("register:"))).toHaveLength(2);
  expect(w.kept.get("ponzu.device")).toBe(JSON.stringify({ userId: "usr_maya", id: "dev_9" }));
});

test("the foreground heartbeat: active for the person's device, and a device the API forgot registers again", async () => {
  let forgotten = true;
  const w = world({
    active: async () => {
      if (forgotten) {
        forgotten = false;
        throw new ApiError(404, "not_found", "There is no such device.");
      }
    },
    register: async () => ({ device: { id: "dev_2" } }),
  });
  await w.store.write("usr_maya", "dev_1");
  const registrar = w.registrar();
  await registrar.active();
  expect(w.calls).toEqual(["active:dev_1", "token", registered()]);
  expect(await w.store.read("usr_maya")).toBe("dev_2");
  w.calls.length = 0;
  await registrar.active();
  expect(w.calls).toEqual(["active:dev_2"]);

  // Nobody's device: no heartbeat.
  const none = world({});
  await none.registrar().active();
  expect(none.calls).toEqual([]);
});

test("Turn on: iOS's prompt, then registering on a yes; a no only blocks a device already there", async () => {
  const yes = world({ permission: "undetermined", answer: "granted" });
  expect(await yes.registrar().request()).toBe("granted");
  expect(yes.calls).toEqual(["prompt", "token", registered()]);

  const no = world({ permission: "undetermined", answer: "denied" });
  expect(await no.registrar().request()).toBe("denied");
  expect(no.calls).toEqual(["prompt"]);
});

test("signing out stops it: a heartbeat finding the device deleted registers nothing again", async () => {
  const w = world({
    active: async () => {
      throw new ApiError(404, "not_found", "There is no such device.");
    },
  });
  await w.store.write("usr_maya", "dev_1");
  const registrar = w.registrar();
  registrar.stop();
  await registrar.active();
  await registrar.tokenChanged();
  expect(await registrar.sync()).toBe("stopped");
  expect(w.calls).toEqual([]);
});

test("signed out while a registration was under way: its device id is not kept", async () => {
  let answer: (value: { device: { id: string } }) => void = () => {};
  const w = world({ register: () => new Promise((resolve) => (answer = resolve)) });
  const registrar = w.registrar();
  const under = registrar.sync();
  for (let i = 0; i < 100 && !w.calls.some((c) => c.startsWith("register:")); i++) {
    await Promise.resolve();
  }
  expect(w.calls.some((c) => c.startsWith("register:"))).toBe(true);
  registrar.stop();
  answer({ device: { id: "dev_1" } });
  expect(await under).toBe("stopped");
  expect(await w.store.read("usr_maya")).toBeNull();
});

test("two registrations asked at once send one", async () => {
  const w = world({});
  const registrar = w.registrar();
  const [a, b] = await Promise.all([registrar.sync(), registrar.sync()]);
  expect([a, b]).toEqual(["registered", "registered"]);
  expect(w.calls.filter((c) => c.startsWith("register:"))).toHaveLength(1);
  // Once it is done, the next one sends again.
  await registrar.sync();
  expect(w.calls.filter((c) => c.startsWith("register:"))).toHaveLength(2);
});

test("a different person signed in here never touches the last person's device", async () => {
  const w = world({ permission: "denied" });
  await w.store.write("usr_maya", "dev_1");
  await w.registrar("usr_sam").sync();
  await w.registrar("usr_sam").active();
  await w.registrar("usr_sam").tokenChanged();
  expect(w.calls).toEqual([]);
});
