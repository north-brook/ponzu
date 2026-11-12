import { ApiError, type NotificationRow } from "@ponzu/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  ACTIVE_BEAT_MS,
  bannerKey,
  inboxStep,
  isActive,
  noticeOfRow,
  timeZoneToSend,
} from "../cloud/notify.ts";
import { useAnalytics } from "./analytics/provider.tsx";
import type { Host } from "./host.ts";
import { usePonzu } from "./ponzu-query.tsx";

/*
 * The Mac's own notifications, while Ponzu runs (docs/cloud.md, "Notifications"). Nothing is
 * pushed to a Mac: the studio watches the person's live inbox (`me.notifications`), and the
 * rules in cloud/notify.ts say which rows show a banner, which banners go, which rows are read
 * because the person is looking at them, and the dock's number. Around them:
 *
 * - this install is registered with the API as the person's Mac (`POST /v1/me/devices`), so
 *   Settings lists it and its pings can be turned off;
 * - while the person is at it (the window focused, with a key, a click or a scroll in the last
 *   two minutes), the API hears so every minute, and at once on focus: their phone's ping then
 *   waits two minutes, and is not sent if the Mac's banner is read;
 * - a banner clicked comes back as a link naming its row (main-window.tsx), which `opened` reads;
 * - the time zone is told to the API once, when it differs from this computer's.
 *
 * In a browser there is no shell, and so no banner, badge or device: only the time zone.
 */

/** When this launch of the studio began: a row made long before it shows no banner. */
const LAUNCHED_AT = Date.now();
/** How long signing out waits for the API to forget this Mac before it goes on regardless. */
const FORGET_WAIT_MS = 2000;

export interface MacNotifications {
  /** This Mac's device, once the API has it: Settings calls it "This Mac". */
  deviceId: string | null;
  /** A banner was clicked and its link followed: the row is read, on this Mac. */
  opened(notificationId: string): void;
  /** Signing out: the API forgets this Mac, so it stops holding the person's phone pings back. */
  forget(): Promise<void>;
}

/** This Mac's device id, for Settings to call its row "This Mac". */
export const ThisDevice = createContext<string | null>(null);
export const useThisDevice = () => useContext(ThisDevice);

/** Whether the window is in front and showing: focused, and not hidden or minimised. */
export function windowFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** `windowFocused`, as it changes. */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(windowFocused);
  useEffect(() => {
    const change = () => setFocused(windowFocused());
    window.addEventListener("focus", change);
    window.addEventListener("blur", change);
    document.addEventListener("visibilitychange", change);
    return () => {
      window.removeEventListener("focus", change);
      window.removeEventListener("blur", change);
      document.removeEventListener("visibilitychange", change);
    };
  }, []);
  return focused;
}

/**
 * The Mac's notifications for the signed-in person. `openCanvasId` is the canvas open in the
 * window: while the window is focused, its rows are read rather than shown.
 */
export function useMacNotifications(host: Host, openCanvasId: string | null): MacNotifications {
  const mac = host.notifications;
  const { queries, mutations, queryClient } = usePonzu();
  const analytics = useAnalytics();
  const focused = useWindowFocused();
  const looking = focused ? openCanvasId : null;
  const settings = useQuery(queries.notifications());
  const { mutate: setTimeZone } = useMutation(mutations.setTimeZone());
  const { mutate: read } = useMutation(mutations.readNotification());

  // The time zone, told once a launch when the API keeps another.
  const toldZone = useRef(false);
  useEffect(() => {
    if (!settings.data || toldZone.current) return;
    toldZone.current = true;
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const zone = timeZoneToSend(settings.data.timeZone, here);
    if (zone) setTimeZone(zone);
  }, [settings.data, setTimeZone]);

  // This Mac, registered at each sign-in and launch, and again once the API has forgotten it.
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [registering, registerAgain] = useState(0);
  useEffect(() => {
    if (!mac) return;
    let current = true;
    host.api.devices
      .register({
        platform: "macos",
        installId: mac.installId,
        name: mac.deviceName,
        appVersion: mac.appVersion,
      })
      .then(
        ({ device }) => {
          if (!current) return;
          setDeviceId(device.id);
          // Settings lists it.
          void queryClient.invalidateQueries({ queryKey: queries.notifications().queryKey });
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [host, mac, queries, queryClient, registering]);

  // The person at this Mac: told every minute while they are, and at once on focus.
  const lastInput = useRef(0);
  useEffect(() => {
    if (!mac) return;
    const input = () => {
      lastInput.current = Date.now();
    };
    const options = { capture: true, passive: true };
    for (const event of ["keydown", "pointerdown", "wheel"]) {
      window.addEventListener(event, input, options);
    }
    return () => {
      for (const event of ["keydown", "pointerdown", "wheel"]) {
        window.removeEventListener(event, input, options);
      }
    };
  }, [mac]);
  useEffect(() => {
    if (!mac || !deviceId) return;
    const beat = () => {
      if (
        !isActive({ focused: windowFocused(), lastInputAt: lastInput.current, now: Date.now() })
      ) {
        return;
      }
      host.api.devices.active(deviceId).catch((error: unknown) => {
        // Forgotten (pruned, or removed from another device): register this Mac again.
        if (error instanceof ApiError && error.code === "not_found") registerAgain((n) => n + 1);
      });
    };
    if (focused) {
      // Coming to the front is the person at it.
      lastInput.current = Date.now();
      beat();
    }
    const timer = setInterval(beat, ACTIVE_BEAT_MS);
    return () => clearInterval(timer);
  }, [host, mac, deviceId, focused]);

  // The inbox, live, while there is a shell to show it.
  const [rows, setRows] = useState<readonly NotificationRow[] | null>(null);
  useEffect(() => {
    if (!mac) return;
    return host.live.subscribe("me.notifications", {}, ({ rows }) => setRows(rows ?? null));
  }, [host, mac]);
  const byId = useRef(new Map<string, NotificationRow>());
  /** Banners up now, by row id; and every row as shown this launch, by `bannerKey`. */
  const showing = useRef(new Set<string>());
  const shown = useRef(new Set<string>());
  const readSent = useRef(new Set<string>());
  const device = settings.data?.devices.find((d) => d.id === deviceId);
  // No banner until this Mac is known, and its pings are on.
  const pings = device?.pings ?? false;
  useEffect(() => {
    if (!mac || !rows) return;
    byId.current = new Map(rows.map((row) => [row.id, row]));
    const step = inboxStep(rows, showing.current, {
      launchedAt: LAUNCHED_AT,
      now: Date.now(),
      shown: shown.current,
      pings,
      looking,
    });
    mac.setBadge(step.badge);
    if (step.remove.length) {
      mac.remove(step.remove);
      for (const id of step.remove) showing.current.delete(id);
    }
    for (const row of step.show) {
      shown.current.add(bannerKey(row));
      const notice = noticeOfRow(row);
      if (!notice || !mac.supported) continue;
      mac.show(notice);
      showing.current.add(row.id);
      analytics.capture("notification shown", { kind: row.kind, surface: "mac" });
    }
    for (const id of step.read) {
      if (readSent.current.has(id)) continue;
      readSent.current.add(id);
      read({ id, via: "mac" });
    }
  }, [mac, rows, pings, looking, analytics, read]);

  // Signed out, or the window's studio gone: nothing of this person's stays on the dock.
  useEffect(() => {
    if (!mac) return;
    const up = showing.current;
    return () => {
      mac.setBadge(0);
      if (up.size) mac.remove([...up]);
      up.clear();
    };
  }, [mac]);

  // An unsigned build's banners are refused by macOS: said once, and the app goes on.
  useEffect(() => {
    if (!mac) return;
    let said = false;
    return mac.onFailed((id) => {
      showing.current.delete(id);
      if (said) return;
      said = true;
      console.warn("macOS didn't show Ponzu's notification. Only a signed build can show them.");
    });
  }, [mac]);

  const opened = useCallback(
    (notificationId: string) => {
      const row = byId.current.get(notificationId);
      analytics.capture("notification opened", {
        kind: row?.kind ?? "unknown",
        surface: "mac",
        ...(row ? { age_ms: Math.max(0, Date.now() - Date.parse(row.createdAt)) } : {}),
      });
      readSent.current.add(notificationId);
      read({ id: notificationId, via: "mac" });
    },
    [analytics, read],
  );

  const forget = useCallback(async () => {
    if (!deviceId) return;
    await Promise.race([
      host.api.devices.remove(deviceId).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, FORGET_WAIT_MS)),
    ]);
  }, [host, deviceId]);

  return { deviceId, opened, forget };
}
