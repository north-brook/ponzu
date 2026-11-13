import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import { LogBox } from "react-native";
import { config } from "../cloud/config";
import type { PingPermission } from "./ask";
import type { PingBehavior } from "./foreground";
import type { PingLike } from "./payload";
import type { PushNative } from "./register";

/*
 * The only file that touches iOS's notifications (expo-notifications, expo-application,
 * expo-device): what lib/push's rules are handed. The component tests replace this module
 * (jest.setup.js), so nothing native runs there.
 */

// expo-notifications reads its server-registration record from the Keychain when it loads. A
// simulator build made without signing (maestro/run.sh) has no Keychain entitlement, so that
// read fails and the library says so with console.error, which a development build shows as a
// full-screen error over the app. Pings never use Expo's server registration, so the failure
// changes nothing; it is kept off the screen (still in the log). A signed build has the
// entitlement and never logs it.
LogBox.ignoreLogs(["[expo-notifications] Error reading persisted server registration info"]);

/** iOS's answer, in the rules' words: provisional and ephemeral count as allowed. */
function permissionOf(answer: Notifications.NotificationPermissionsStatus): PingPermission {
  const ios = answer.ios?.status;
  if (ios !== undefined) {
    if (ios === Notifications.IosAuthorizationStatus.NOT_DETERMINED) return "undetermined";
    if (ios === Notifications.IosAuthorizationStatus.DENIED) return "denied";
    return "granted";
  }
  return answer.status === "granted"
    ? "granted"
    : answer.status === "denied"
      ? "denied"
      : "undetermined";
}

export const native: PushNative = {
  permission: async () => permissionOf(await Notifications.getPermissionsAsync()),
  requestPermission: async () =>
    permissionOf(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: true },
      }),
    ),
  expoToken: async () => {
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
      ?.eas?.projectId;
    return (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : {})).data;
  },
  environment: () => Application.getIosPushNotificationServiceEnvironmentAsync(),
  onTokenChange: (listener) => {
    const sub = Notifications.addPushTokenListener(() => listener());
    return () => sub.remove();
  },
};

/** "iPhone 16 Pro", as the phone names its model; null when it won't say. */
export const deviceName = (): string | null => Device.modelName ?? null;

/** The version running: the app's, and the update's (or `embedded`), at most 40 characters. */
export function appVersion(): string {
  const update = Updates.updateId ? Updates.updateId.slice(0, 8) : "embedded";
  return `${config().version}+${update}`.slice(0, 40);
}

/** The app icon's number. */
export const setBadge = (count: number): Promise<unknown> =>
  Notifications.setBadgeCountAsync(count).catch(() => false);

/** How a ping arriving in the foreground shows: `behavior` decides each. */
export function handleForeground(behavior: (notification: PingLike) => PingBehavior): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => behavior(notification),
  });
}

/** Hears taps on pings: the one that opened the app from cold, then each one after. */
export function onTap(listener: (notification: PingLike) => void): () => void {
  // The tap that opened the app may also reach the listener: it is taken once.
  let taken: string | null = null;
  const take = (response: Notifications.NotificationResponse) => {
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (id && id === taken) return;
    taken = id;
    listener(response.notification);
  };
  const last = Notifications.getLastNotificationResponse();
  if (last) take(last);
  const sub = Notifications.addNotificationResponseReceivedListener(take);
  return () => sub.remove();
}

/** The tap has been taken: a remount doesn't take it again. */
export const tapTaken = (): void => Notifications.clearLastNotificationResponse();

/** Clears from Notification Center the pings about `canvasId`, once it is open. */
export async function dismissFor(
  canvasId: string,
  canvasOf: (n: PingLike) => string | null,
): Promise<void> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      shown
        .filter((n) => canvasOf(n) === canvasId)
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
    );
  } catch {
    // Left in the list: tapping one still opens the canvas.
  }
}
