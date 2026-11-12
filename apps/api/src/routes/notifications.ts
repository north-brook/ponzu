import {
  DEVICE_PLATFORMS,
  type Device,
  deleteDevice,
  EXPO_PUSH_TOKEN,
  listDevices,
  PUSH_ENVIRONMENTS,
  pingPrefsOf,
  QueryError,
  registerDevice,
  setPingPrefs,
  updateDevice,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";

/*
 * Settings › Notifications (docs/cloud.md, "Notifications"): which events ping the person, and
 * the devices pings go to. The iPhone registers itself once the person turns notifications on,
 * with its Expo push token. The Mac registers its install, with no token: it shows its own
 * notifications while the app runs.
 */

const PingPrefs = z.object({
  /** "Ponzu needs you": a question, a permission, a sign-in. */
  needsYou: z.boolean(),
  /** "Ponzu replies to my comment", on canvases they commented on. */
  replies: z.boolean(),
  /** "A pull request is ready": checks passed and it can merge. */
  prReady: z.boolean(),
  /** "A teammate comments", on canvases they own. */
  teammateComments: z.boolean(),
  /** One email a day, and nothing else by email. */
  emailDigest: z.boolean(),
});

/** A device as Settings lists it. Never its push token. */
const DeviceView = z.object({
  id: z.string(),
  platform: z.enum(DEVICE_PLATFORMS),
  /** "iPhone 16 Pro", as the device names itself. */
  name: z.string().nullable(),
  appVersion: z.string().nullable(),
  /** The person's toggle for this device. */
  pings: z.boolean(),
  /** The device's own settings turned Ponzu's notifications off: nothing reaches it. */
  blocked: z.boolean(),
  lastSeenAt: z.date(),
  createdAt: z.date(),
});

const toView = (device: Device): z.input<typeof DeviceView> => ({
  ...device,
  pings: device.pingsEnabled,
  blocked: device.pingsBlocked,
});

const Notifications = z.object({ prefs: PingPrefs, devices: z.array(DeviceView) });
const DeviceAnswer = z.object({ device: DeviceView });

/** An Expo push token, `ExponentPushToken[…]`, kept exactly as the phone gave it. */
const PushToken = z
  .string()
  .regex(EXPO_PUSH_TOKEN, "A push token is the device's Expo push token, ExponentPushToken[…].");
const DeviceName = z.string().trim().min(1).max(100);
const AppVersion = z.string().trim().min(1).max(40);

const Registration = z
  .object({
    platform: z.enum(DEVICE_PLATFORMS),
    /** An iPhone's Expo push token. A Mac has none. */
    pushToken: PushToken.optional(),
    /** Which APNs an iPhone's token is for: a development build's or the App Store's. */
    pushEnvironment: z.enum(PUSH_ENVIRONMENTS).optional(),
    /**
     * The app's own random id for this install, made once and kept in the Keychain: what lets
     * the phone, signed in as someone else, take its token along. Never returned.
     */
    installId: z
      .string()
      .regex(/^[A-Za-z0-9-]{16,64}$/, "An install id is 16 to 64 letters, digits or dashes."),
    name: DeviceName.nullish(),
    appVersion: AppVersion.nullish(),
    blocked: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.platform === "ios") {
      if (!body.pushToken) {
        ctx.addIssue({
          code: "custom",
          path: ["pushToken"],
          message: "An iPhone needs its push token.",
        });
      }
      if (!body.pushEnvironment) {
        ctx.addIssue({
          code: "custom",
          path: ["pushEnvironment"],
          message: "An iPhone says which APNs its token is for.",
        });
      }
    } else if (body.pushToken !== undefined || body.pushEnvironment !== undefined) {
      ctx.addIssue({ code: "custom", path: ["pushToken"], message: "A Mac has no push token." });
    }
  });
const DeviceChanges = z
  .object({
    pings: z.boolean(),
    blocked: z.boolean(),
    name: DeviceName.nullable(),
    appVersion: AppVersion.nullable(),
    /** Expo gave the app a new token. Only an iPhone has one. */
    pushToken: PushToken,
  })
  .partial();
const DeviceParam = z.object({ id: z.string().min(1).max(64) });

export const notifications = new Hono<AppEnv>()
  /** The person's toggles and their devices, the one seen last first. */
  .get("/notifications", access.user, async (c) => {
    const { deps, actor } = c.var;
    const devices = await listDevices(deps.db, actor.user.id);
    return c.json(
      Notifications.parse({ prefs: pingPrefsOf(actor.user), devices: devices.map(toView) }),
    );
  })

  /** Change some toggles; the rest stay. Each saves as it is flipped, on any device. */
  .patch("/notifications", access.user, validate("json", PingPrefs.partial()), async (c) => {
    const { deps, actor } = c.var;
    const [prefs, devices] = await Promise.all([
      setPingPrefs(deps.db, { userId: actor.user.id, prefs: c.req.valid("json") }),
      listDevices(deps.db, actor.user.id),
    ]);
    return c.json(Notifications.parse({ prefs, devices: devices.map(toView) }));
  })

  /**
   * Register this device for pings, or say again that it is here: 201 when it is new to the
   * person, 200 when it was theirs already. A token another person registered moves to this
   * one only from the same install (the phone signed in as someone else); from any other, it is
   * 409 `push_token_taken` and stays theirs.
   */
  .post("/devices", access.user, validate("json", Registration), async (c) => {
    const { deps, actor, log } = c.var;
    const body = c.req.valid("json");
    const common = {
      userId: actor.user.id,
      installId: body.installId,
      name: body.name ?? null,
      appVersion: body.appVersion ?? null,
    };
    const registered = await registerDevice(
      deps.db,
      body.platform === "ios"
        ? {
            ...common,
            platform: "ios",
            pushToken: body.pushToken!,
            pushEnvironment: body.pushEnvironment!,
            pingsBlocked: body.blocked ?? false,
          }
        : { ...common, platform: "macos" },
    );
    if (registered.status === "taken") {
      log.warn("device_token_conflict", { userId: actor.user.id, holderId: registered.holderId });
      throw new ApiError(409, "push_token_taken", "Another account has this device.");
    }
    const { device, created, movedFrom } = registered;
    if (movedFrom) {
      log.info("device_token_moved", { deviceId: device.id, from: movedFrom, to: actor.user.id });
    }
    log.info("device_registered", { deviceId: device.id, created });
    return c.json(DeviceAnswer.parse({ device: toView(device) }), created ? 201 : 200);
  })

  /** Change one of the person's devices: its toggle, what iOS allows, its name, a new token. */
  .patch(
    "/devices/:id",
    access.user,
    validate("param", DeviceParam),
    validate("json", DeviceChanges),
    async (c) => {
      const { deps, actor } = c.var;
      const { pings, blocked, ...rest } = c.req.valid("json");
      let device: Device | null;
      try {
        device = await updateDevice(deps.db, {
          userId: actor.user.id,
          id: c.req.valid("param").id,
          changes: {
            ...rest,
            ...(pings === undefined ? {} : { pingsEnabled: pings }),
            ...(blocked === undefined ? {} : { pingsBlocked: blocked }),
          },
        });
      } catch (error) {
        if (error instanceof QueryError && error.message.includes("devices_push_token_unique")) {
          throw new ApiError(409, "push_token_taken", "Another device already has that token.");
        }
        if (error instanceof QueryError && error.message.includes("devices_push_token_check")) {
          throw new ApiError(400, "invalid_request", "A Mac has no push token.");
        }
        throw error;
      }
      if (!device) throw new ApiError(404, "not_found", "There is no such device.");
      return c.json(DeviceAnswer.parse({ device: toView(device) }));
    },
  )

  /** Forget a device: the app signed out on it. Nothing more is sent to it. */
  .delete("/devices/:id", access.user, validate("param", DeviceParam), async (c) => {
    const { deps, actor } = c.var;
    const deleted = await deleteDevice(deps.db, {
      userId: actor.user.id,
      id: c.req.valid("param").id,
    });
    if (!deleted) throw new ApiError(404, "not_found", "There is no such device.");
    return c.body(null, 204);
  });
