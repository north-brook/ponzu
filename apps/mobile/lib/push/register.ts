import { ApiError } from "@ponzu/client";
import type { PingPermission } from "./ask";

/*
 * This phone as one of the person's devices for pings (iPhone design §12, notifications §6),
 * through `POST /v1/me/devices`, with its Expo push token. Everything outside is handed in
 * (iOS's notifications and APNs environment, the API, where the device's id is kept, analytics),
 * so the rules are tested with fakes (register.test.ts).
 *
 * - **Allowed:** the Expo token (tried three times), the APNs environment, then register with
 *   the install id. A null environment is the simulator, which has no APNs: nothing is sent.
 * - **Refused in iOS:** a device already registered is told `blocked`; none is made.
 * - **Not asked yet:** nothing. The ask (ask.ts) comes after a comment.
 * - **409 `push_token_taken`:** another account holds this token from another install. It is
 *   noted to analytics once, with no token, and not tried again in this run.
 * - **A new token** (Expo's listener): the device is patched with it.
 *
 * Each run is keyed to one person: the device's id is kept with whose it is, so a sign-in as
 * someone else never patches or deletes the last person's device.
 */

export interface PushNative {
  /** iOS's answer for Ponzu's notifications. */
  permission(): Promise<PingPermission>;
  /** iOS's prompt (alert, sound and badge); its answer. */
  requestPermission(): Promise<PingPermission>;
  /** This install's Expo push token, `ExponentPushToken[…]`. */
  expoToken(): Promise<string>;
  /** Which APNs the build's token is for; null on the simulator. */
  environment(): Promise<"development" | "production" | null>;
  /** iOS handed the app a new token. */
  onTokenChange(listener: () => void): () => void;
}

/** The device routes this needs (the client's `api.devices`). */
export interface DeviceRoutes {
  register(body: {
    platform: "ios";
    pushToken: string;
    pushEnvironment: "development" | "production";
    installId: string;
    name?: string | null;
    appVersion?: string | null;
    blocked?: boolean;
  }): Promise<{ device: { id: string } }>;
  update(
    id: string,
    changes: { blocked?: boolean; pushToken?: string },
  ): Promise<{ device: { id: string } }>;
  active(id: string): Promise<void>;
}

/** Where this phone's device id is kept, with whose it is. */
export interface DeviceStore {
  read(userId: string): Promise<string | null>;
  write(userId: string, id: string | null): Promise<void>;
}

export type SyncResult =
  | "registered"
  | "blocked"
  | "undetermined"
  | "simulator"
  | "conflict"
  | "failed"
  | "stopped";

export interface RegistrarDeps {
  native: PushNative;
  devices: DeviceRoutes;
  store: DeviceStore;
  userId: string;
  installId: () => Promise<string>;
  name: string | null;
  appVersion: string | null;
  /** A token another account holds: told once, with nothing of the token. */
  onConflict(): void;
  /** Waits between tries for a token; a test resolves it at once. */
  wait(ms: number): Promise<void>;
}

const TOKEN_TRIES = 3;

const isStatus = (error: unknown, status: number, code?: string) =>
  error instanceof ApiError &&
  error.status === status &&
  (code === undefined || error.code === code);

export function createRegistrar(deps: RegistrarDeps) {
  let conflictTold = false;
  /** Signing out: nothing more is registered, patched or said for this person. */
  let stopped = false;
  /** The registration under way, which a second ask joins rather than sending its own. */
  let syncing: Promise<SyncResult> | null = null;
  const conflict = () => {
    if (conflictTold) return;
    conflictTold = true;
    deps.onConflict();
  };

  const token = async (): Promise<string | null> => {
    for (let i = 0; i < TOKEN_TRIES; i++) {
      try {
        return await deps.native.expoToken();
      } catch {
        if (i < TOKEN_TRIES - 1) await deps.wait(1_000 * 2 ** i);
      }
    }
    return null;
  };

  /**
   * Register (or say again) this phone as iOS now allows it. One at a time: iOS's prompt brings
   * the app forward while Turn on registers, and both would ask at once.
   */
  const sync = (): Promise<SyncResult> => {
    if (stopped) return Promise.resolve("stopped");
    syncing ??= syncOnce().finally(() => {
      syncing = null;
    });
    return syncing;
  };

  const syncOnce = async (): Promise<SyncResult> => {
    let permission: PingPermission;
    try {
      permission = await deps.native.permission();
    } catch {
      return "failed";
    }
    if (permission === "undetermined") return "undetermined";
    if (permission === "denied") {
      const id = await deps.store.read(deps.userId);
      if (id) {
        try {
          await deps.devices.update(id, { blocked: true });
        } catch (error) {
          if (isStatus(error, 404)) await deps.store.write(deps.userId, null);
        }
      }
      return "blocked";
    }
    let environment: "development" | "production" | null;
    try {
      environment = await deps.native.environment();
    } catch {
      return "failed";
    }
    if (environment === null) return "simulator";
    const pushToken = await token();
    if (!pushToken) return "failed";
    // Signed out while the token came: a device made now would ping a phone nobody is on.
    if (stopped) return "stopped";
    try {
      const { device } = await deps.devices.register({
        platform: "ios",
        pushToken,
        pushEnvironment: environment,
        installId: await deps.installId(),
        name: deps.name,
        appVersion: deps.appVersion,
        blocked: false,
      });
      if (stopped) return "stopped";
      await deps.store.write(deps.userId, device.id);
      return "registered";
    } catch (error) {
      if (isStatus(error, 409, "push_token_taken")) {
        conflict();
        return "conflict";
      }
      return "failed";
    }
  };

  /** Expo's token changed: the device is told the new one. */
  const tokenChanged = async (): Promise<void> => {
    if (stopped) return;
    const id = await deps.store.read(deps.userId);
    if (!id) return;
    const pushToken = await token();
    if (!pushToken) return;
    try {
      await deps.devices.update(id, { pushToken });
    } catch (error) {
      if (isStatus(error, 409, "push_token_taken")) conflict();
      else if (isStatus(error, 404)) {
        await deps.store.write(deps.userId, null);
        await sync();
      }
    }
  };

  /**
   * The person is at this phone (the foreground): a ping waits for them at their Mac only when
   * they're there. A device the API forgot is registered again.
   */
  const active = async (): Promise<void> => {
    if (stopped) return;
    const id = await deps.store.read(deps.userId);
    if (!id) return;
    try {
      await deps.devices.active(id);
    } catch (error) {
      if (isStatus(error, 404)) {
        await deps.store.write(deps.userId, null);
        await sync();
      }
    }
  };

  /** iOS's prompt, then registering on a yes (or telling a device on a no). */
  const request = async (): Promise<PingPermission> => {
    let answer: PingPermission;
    try {
      answer = await deps.native.requestPermission();
    } catch {
      return "undetermined";
    }
    if (answer !== "undetermined") await sync();
    return answer;
  };

  /**
   * Signing out: from now on this registrar sends nothing, so a heartbeat that finds the device
   * just deleted (404) can't register it again for someone no longer signed in.
   */
  const stop = (): void => {
    stopped = true;
  };

  return { sync, tokenChanged, active, request, stop };
}

export type Registrar = ReturnType<typeof createRegistrar>;

/** A `DeviceStore` over AsyncStorage-like storage at `key`: `{ userId, id }` as JSON. */
export function deviceStore(
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  },
  key: string,
): DeviceStore {
  return {
    async read(userId) {
      try {
        const raw = await storage.getItem(key);
        if (!raw) return null;
        const kept = JSON.parse(raw) as { userId?: unknown; id?: unknown };
        return kept.userId === userId && typeof kept.id === "string" ? kept.id : null;
      } catch {
        return null;
      }
    },
    async write(userId, id) {
      try {
        if (id === null) await storage.removeItem(key);
        else await storage.setItem(key, JSON.stringify({ userId, id }));
      } catch {
        // Not kept: the next launch registers again, which finds the same device by install.
      }
    },
  };
}
