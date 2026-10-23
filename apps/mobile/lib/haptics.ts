import {
  ImpactFeedbackStyle,
  impactAsync,
  NotificationFeedbackType,
  notificationAsync,
  selectionAsync,
} from "expo-haptics";

/**
 * The app's haptics, one vocabulary, as augmenter's: each gesture gets one,
 * never a stream, and none for scrolling or for motion the person didn't
 * cause. They follow the system's haptics setting; there's no setting of
 * our own. docs/mobile.md lists which event gets which.
 */

/** Haptics are garnish: a device without them, or a failure, is silent. */
const quiet = () => undefined;

/**
 * Development: each haptic is logged to Metro (`[haptic] tick`), so a
 * simulator, which can't buzz, shows one per gesture.
 */
let log: ((kind: string) => void) | null =
  typeof __DEV__ !== "undefined" && __DEV__ ? (k) => console.log(`[haptic] ${k}`) : null;

/** Tests: where haptics are reported, or nowhere. */
export function onHaptic(fn: ((kind: string) => void) | null) {
  log = fn;
}

/** A light tick: opening something, going back, a focus landing, a pin dropped. */
export function tick() {
  log?.("tick");
  impactAsync(ImpactFeedbackStyle.Light).catch(quiet);
}

/** A change of selection: a tab, a menu opening, a filter or page picked. */
export function select() {
  log?.("select");
  selectionAsync().catch(quiet);
}

/** Something done: a comment sent, a thread resolved, a Mac paired or woken. */
export function success() {
  log?.("success");
  notificationAsync(NotificationFeedbackType.Success).catch(quiet);
}

/** Something taken away: a design archived. */
export function thud() {
  log?.("thud");
  impactAsync(ImpactFeedbackStyle.Medium).catch(quiet);
}

/** Something that needs a second look. */
export function warn() {
  log?.("warn");
  notificationAsync(NotificationFeedbackType.Warning).catch(quiet);
}

/** Something that didn't work: a pairing error, a comment that didn't send, a Mac that didn't wake. */
export function fail() {
  log?.("fail");
  notificationAsync(NotificationFeedbackType.Error).catch(quiet);
}
