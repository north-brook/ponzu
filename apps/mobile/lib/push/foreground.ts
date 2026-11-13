import { canvasOf, type PingLike } from "./payload";

/*
 * A ping that arrives while Ponzu is open (iPhone design §12). One about the canvas on screen
 * shows nothing, neither a banner nor a row in Notification Center: the screen already shows it,
 * and the API is told the person is looking (presence `focused`), so it seldom sends one at all.
 * Any other shows its banner and stays in the list, silently, since the person is in the app.
 * The badge is the API's count, set whatever the ping is about.
 */

export interface PingBehavior {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

/** How a ping that arrives in the foreground shows, with `onScreen` the canvas on screen. */
export function behaviorFor(notification: PingLike, onScreen: string | null): PingBehavior {
  const canvasId = canvasOf(notification);
  const here = canvasId !== null && canvasId === onScreen;
  return {
    shouldShowBanner: !here,
    shouldShowList: !here,
    shouldPlaySound: false,
    shouldSetBadge: true,
  };
}

/**
 * The canvas on screen while the app is in front, as the canvas screen says (null otherwise):
 * what the foreground handler and a tap on a ping for the same canvas go by.
 */
let onScreen: string | null = null;

export function setOnScreen(canvasId: string | null): void {
  onScreen = canvasId;
}

export function canvasOnScreen(): string | null {
  return onScreen;
}
