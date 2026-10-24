import type { AgentChange, Presence } from "@ponzu/core";
import { useHinge } from "expo-hinge";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { SensorType, useAnimatedReaction, useAnimatedSensor } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { agentWorking, isStill, standbyOn, standbyPose } from "./standby";

/**
 * Whether standby shows (lib/standby.ts): the pose from the window and the
 * hinge, the phone set down from gravity (Reanimated's sensor, CoreMotion
 * underneath), and an agent working here from presence. `force` is
 * development's `?standby=1`, for the simulator, which has no motion.
 */
export function useStandby(presence: Presence[], file: string, force = false): boolean {
  const window = useWindowDimensions();
  const hinge = useHinge();
  const still = useStill();
  const pose = standbyPose(window, hinge?.status ?? null);
  return force || standbyOn(pose, still, agentWorking(presence, file));
}

/** The display stays on while standby shows, as StandBy keeps it. */
export function StandbyAwake() {
  useKeepAwake("standby");
  return null;
}

/**
 * The phone set down: gravity steady for a moment. Readings come every
 * 100ms on the UI thread and are judged on the JS thread; a phone without
 * the sensor (the simulator) reads as still.
 */
function useStill(): boolean {
  const sensor = useAnimatedSensor(SensorType.GRAVITY, { interval: 100 });
  const samples = useRef<[number, number, number, number][]>([]);
  const [still, setStill] = useState(false);
  const seen = useRef(false);
  const take = (x: number, y: number, z: number) => {
    seen.current = true;
    const now = Date.now();
    const s = samples.current;
    s.push([now, x / 9.81, y / 9.81, z / 9.81]);
    while (s.length && s[0]![0] < now - 3000) s.shift();
    const next = isStill(s);
    setStill((was) => (was === next ? was : next));
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
      if (!seen.current) setStill(true);
    }, 2000);
    return () => clearTimeout(t);
  }, []);
  return still;
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
