import type { AgentChange, Presence } from "@ponzu/core";
import { useHinge } from "expo-hinge";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { SensorType, useAnimatedReaction, useAnimatedSensor } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { agentWorking, isStill, listenForStill, standbyOn, standbyPose } from "./standby";

/**
 * Whether standby shows (lib/standby.ts): the pose from the window and the
 * hinge, the phone set down from gravity (Reanimated's sensor, CoreMotion
 * underneath), and an agent working here from presence. `force` is
 * development's `?standby=1`, for the simulator, which has no motion.
 *
 * Gravity is read only while the pose and an agent already hold (`listen`,
 * which the screen answers by rendering `<StillSensor>`): an iPhone is never
 * in the pose, so it never runs the sensor, which otherwise wakes the UI and
 * JS threads ten times a second for as long as a design is open.
 */
export function useStandby(
  presence: Presence[],
  file: string,
  force = false,
): { standby: boolean; listen: boolean; setStill: (still: boolean) => void } {
  const window = useWindowDimensions();
  const hinge = useHinge();
  const [still, setStill] = useState(false);
  const pose = standbyPose(window, hinge?.status ?? null);
  const working = agentWorking(presence, file);
  const listen = listenForStill(pose, working);
  // Not listening, the last reading means nothing: picked up and set down again, it's read anew.
  useEffect(() => {
    if (!listen) setStill(false);
  }, [listen]);
  return { standby: force || standbyOn(pose, still, working), listen, setStill };
}

/** The display stays on while standby shows, as StandBy keeps it. */
export function StandbyAwake() {
  useKeepAwake("standby");
  return null;
}

/**
 * Reads gravity while it's mounted, and says when the phone is set down or
 * picked up. Readings come every 100ms on the UI thread and are judged on the
 * JS thread; a phone without the sensor (the simulator) reads as still.
 */
export function StillSensor({ onStill }: { onStill: (still: boolean) => void }) {
  const sensor = useAnimatedSensor(SensorType.GRAVITY, { interval: 100 });
  const samples = useRef<[number, number, number, number][]>([]);
  const last = useRef<boolean | null>(null);
  const seen = useRef(false);
  const say = (next: boolean) => {
    if (last.current === next) return;
    last.current = next;
    onStill(next);
  };
  const take = (x: number, y: number, z: number) => {
    seen.current = true;
    const now = Date.now();
    const s = samples.current;
    s.push([now, x / 9.81, y / 9.81, z / 9.81]);
    while (s.length && s[0]![0] < now - 3000) s.shift();
    say(isStill(s));
  };
  useAnimatedReaction(
    () => sensor.sensor.value,
    (v) => {
      scheduleOnRN(take, v.x, v.y, v.z);
    },
  );
  useEffect(() => {
    // No readings at all: a device without the sensor, which is never in a hand.
    const t = setTimeout(() => {
      if (!seen.current) say(true);
    }, 2000);
    return () => clearTimeout(t);
  }, []);
  return null;
}

/**
 * The board standby's camera rests on now: it moves to each in turn, resting
 * between, from `path` (lib/standby.ts `standbyPath`), and starts over with
 * the newest as the path changes.
 */
export function useFollow(
  path: string[],
  on: boolean,
  times: { move: number; rest: number },
): string | null {
  const [i, setI] = useState(0);
  const key = path.join(",");
  // A new board in the path is where the agent is now: go there first.
  useEffect(() => setI(0), [path[0]]);
  useEffect(() => {
    if (!on || path.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % path.length), times.move + times.rest);
    return () => clearInterval(t);
  }, [on, key]);
  return on ? (path[i % Math.max(1, path.length)] ?? null) : null;
}

export type { AgentChange };
