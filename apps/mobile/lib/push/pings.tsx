import { useSessionState } from "@ponzu/client/react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import { type Href, router, useSegments } from "expo-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import { backend } from "../cloud/backend";
import { gateStep } from "../cloud/gate";
import { useCloud } from "../cloud/query";
import { DEVICE_KEY } from "../cloud/sign-out";
import { useSetupStep } from "../cloud/use-setup";
import { CANVAS_WORDS } from "../copy";
import { setListNotice } from "../list-notice";
import { track } from "../telemetry";
import { afterComment, asked, declined, readAsk, writeAsk } from "./ask";
import { behaviorFor, canvasOnScreen } from "./foreground";
import {
  appVersion,
  deviceName,
  handleForeground,
  native,
  onTap,
  setBadge,
  tapTaken,
} from "./native";
import { type Tap, tapOf } from "./payload";
import { createRegistrar, deviceStore, type Registrar } from "./register";
import { tapCanGo, tapIsStale, tapMove } from "./route";

/*
 * Pings on this phone (docs/mobile.md, "Pings"): taps routed once the app can show them, this
 * phone registered for the person signed in, the foreground's banners, the badge, and the ask
 * after a comment. All of it but the taps waits on the API: while `GET /v1/me` says
 * `features.push` is false (no Expo access token on the server), nothing is asked, registered,
 * written or counted, and the canvas's presence says nothing of focus. The app then behaves as
 * it did before pings.
 */

/** This phone's device id, kept with whose it is (the sign-out deletes it first). */
export const devices = deviceStore(AsyncStorage, DEVICE_KEY);

/* The tap held until the app can show it. */
let held: Tap | null = null;
const heldListeners = new Set<() => void>();
const holdTap = (tap: Tap | null) => {
  held = tap;
  for (const listener of heldListeners) listener();
};
/** Forget a tap waiting to go (tests, between them). */
export const dropHeldTap = () => holdTap(null);
const subscribeHeld = (listener: () => void) => {
  heldListeners.add(listener);
  return () => heldListeners.delete(listener);
};

export interface Pings {
  /** The API sends pings (`features.push`): everything else here is on. */
  on: boolean;
  /** A comment went from this phone: true when the ask should show now. */
  afterComment(): Promise<boolean>;
  /** Turn on notifications: iOS's prompt, then registering. */
  turnOn(): Promise<void>;
  /** Not now, or the sheet swiped away. */
  notNow(): Promise<void>;
}

const OFF: Pings = {
  on: false,
  afterComment: async () => false,
  turnOn: async () => {},
  notNow: async () => {},
};

const PingsContext = createContext<Pings>(OFF);

/** Pings for whoever is signed in; off while nobody is, or the API sends none. */
export function usePings(): Pings {
  return useContext(PingsContext);
}

export function PingsProvider({ children }: { children: ReactNode }) {
  const { userId } = useCloud();
  const session = useSessionState(backend.session);
  const [pings, setPings] = useState<Pings>(OFF);

  // Taps, from the first moment: the one that opened the app, then each after it. A ping's
  // foreground banner goes by the canvas on screen.
  useEffect(() => {
    handleForeground((notification) => behaviorFor(notification, canvasOnScreen()));
    return onTap((notification) => {
      tapTaken();
      const tap = tapOf(notification);
      holdTap(tap);
      // Signed out once the Keychain is read, a tap opens nothing: the ping was for whoever was
      // signed in then. (At a cold start the session is still being read when the tap arrives.)
      void backend
        .prepare()
        .catch(() => {})
        .then(() => {
          if (held === tap && tapIsStale(backend.session.getState())) holdTap(null);
        });
    });
  }, []);
  // Signed out since, a held tap is dropped too. (How things stand at launch is the check above.)
  const was = useRef(session.status);
  useEffect(() => {
    if (was.current !== session.status && tapIsStale(session)) holdTap(null);
    was.current = session.status;
  }, [session.status]);

  return (
    <PingsContext.Provider value={userId ? pings : OFF}>
      {children}
      {userId && <PersonPings key={userId} userId={userId} onPings={setPings} />}
    </PingsContext.Provider>
  );
}

/** Everything that is one person's: keyed by them, so a sign-in as someone else starts afresh. */
function PersonPings({ userId, onPings }: { userId: string; onPings: (p: Pings) => void }) {
  const cloud = useCloud();
  const session = useSessionState(backend.session);
  const me = useQuery({ ...cloud.queries.me(), enabled: !cloud.restoring });
  const on = me.data?.features?.push === true;
  const setup = gateStep(useSetupStep());
  const segments = useSegments() as string[];
  const tap = useSyncExternalStore(subscribeHeld, () => held);

  const registrar = useMemo<Registrar>(
    () =>
      createRegistrar({
        native,
        devices: backend.api.devices,
        store: devices,
        userId,
        installId: () => backend.installId(),
        name: deviceName(),
        appVersion: appVersion(),
        onConflict: () => track("device token conflict"),
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
    [userId],
  );

  /** The icon's number: the API's count of questions waiting, across every workspace. */
  const badge = useRef(async () => {
    try {
      const answer = await cloud.queryClient.fetchQuery({
        ...cloud.queries.notifications(),
        staleTime: 0,
      });
      await setBadge(answer.badge);
    } catch {
      // Kept as it was until the next time the app comes forward.
    }
  });

  // Registered at launch, and again when iOS's answer changed while the app was away. In front,
  // the API hears the person is at this phone, every minute, and the badge is brought up to date.
  useEffect(() => {
    if (!on) return;
    let live = true;
    let last: string | null = null;
    let beat: ReturnType<typeof setInterval> | null = null;
    const forward = async () => {
      const permission = await native.permission().catch(() => null);
      if (!live) return;
      if (permission !== last) {
        last = permission;
        await registrar.sync();
      }
      if (!live) return;
      await registrar.active();
      await badge.current();
    };
    const start = () => {
      void forward();
      beat ??= setInterval(() => void registrar.active(), 60_000);
    };
    const stop = () => {
      if (beat) clearInterval(beat);
      beat = null;
    };
    if (AppState.currentState !== "background") start();
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") start();
      else if (state === "background") stop();
    });
    const token = native.onTokenChange(() => void registrar.tokenChanged());
    return () => {
      live = false;
      stop();
      app.remove();
      token();
    };
  }, [on, registrar]);

  useEffect(() => {
    onPings(
      on
        ? {
            on,
            async afterComment() {
              const permission = await native.permission().catch(() => null);
              if (!permission) return false;
              const ask = await readAsk(AsyncStorage);
              const next = afterComment({ pushOn: true, permission, ask, now: Date.now() });
              if (next === "register") void registrar.sync();
              if (next !== "ask") return false;
              await writeAsk(AsyncStorage, asked(ask, Date.now()));
              return true;
            },
            async turnOn() {
              await registrar.request();
              await badge.current();
            },
            async notNow() {
              await writeAsk(AsyncStorage, declined(await readAsk(AsyncStorage), Date.now()));
            },
          }
        : OFF,
    );
  }, [on, registrar, onPings]);
  useEffect(() => () => onPings(OFF), [onPings]);

  // A held tap goes once the app can show it: signed in, through setup, off the launch screen.
  const ready = tapCanGo(session, setup, segments);
  useEffect(() => {
    if (!tap || !ready) return;
    holdTap(null);
    const move = tapMove(tap, canvasOnScreen());
    if (move.kind === "params") router.setParams(move.params);
    else if (move.kind === "push") router.push(move.path as Href);
    else {
      // Nothing this build can open: the canvases, saying so.
      setListNotice(CANVAS_WORDS.gone);
      router.dismissTo("/canvases");
    }
    if (tap.notificationId) {
      backend.api.notifications.read(tap.notificationId, "ios").catch(() => {});
    }
  }, [tap, ready]);

  return null;
}
