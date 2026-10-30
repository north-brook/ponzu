import PostHog from "posthog-react-native";
import type { GesturePerf } from "../canvas/protocol";
import type { MacInfo } from "./mac";
import { cachedInfos } from "./macs";
import { queryClient } from "./query";
import { VERSION } from "./ua";

/**
 * Usage events, only where the person allows them. The key exists only in
 * production builds (`EXPO_PUBLIC_POSTHOG_KEY`, from EAS); without it the
 * phone sends nothing. The phone has no identity of its own: it reports as
 * the Tailscale owner hash the first answering Mac hands it, and if any
 * paired Mac has telemetry off, it sends nothing at all. No session replay,
 * no touch autocapture: those would capture design content.
 */
export type Event =
  | ["app opened", Record<string, never>?]
  | ["mac paired", { via: "qr" }]
  | ["canvas opened", Record<string, never>?]
  | ["comment left", { reply: boolean; mode: "voice" | "type" }]
  | ["activity opened", Record<string, never>?]
  | ["link opened", { kind: "design" | "unpaired" | "missing" | "invalid" }]
  /** A sample of gestures on the canvas (pans, pinches, double-taps): how the canvas's frames kept up (lib/canvas-perf.ts). */
  | ["canvas gesture", GesturePerf];

const KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

/** Whether this build could send anything: production, with the key. */
export const canTrack = Boolean(KEY);

let client: PostHog | null = null;
let owner: string | null = null;
/** Events from before any Mac answered, sent once one does (if it allows them). */
let queue: Event[] = [];
let decided = false;

/** On, with this owner, or off; from every Mac the phone has heard from. */
export function decide(all: Record<string, MacInfo>): { on: false } | { on: true; owner: string } {
  const answers = Object.values(all).filter((i) => i.telemetry);
  if (!answers.length) return { on: false };
  if (answers.some((i) => !i.telemetry!.on)) return { on: false };
  const first = answers.find((i) => i.telemetry!.owner);
  return first ? { on: true, owner: first.telemetry!.owner! } : { on: false };
}

function apply() {
  if (!KEY) return;
  const all = cachedInfos();
  if (!Object.keys(all).length) return;
  decided = true;
  const d = decide(all);
  if (!d.on) {
    client?.optOut();
    queue = [];
    return;
  }
  if (!client) {
    client = new PostHog(KEY, {
      host: HOST,
      enableSessionReplay: false,
      captureAppLifecycleEvents: false,
      persistence: "file",
    });
    client.register({ surface: "ios", version: VERSION });
  } else client.optIn();
  if (owner !== d.owner) {
    owner = d.owner;
    client.identify(d.owner);
  }
  for (const [name, props] of queue) client.capture(name, props ?? {});
  queue = [];
}

// Whenever a Mac's info comes in or changes.
queryClient.getQueryCache().subscribe((e) => {
  if (e.type === "updated" && e.action.type === "success" && e.query.queryKey[2] === "info")
    apply();
});

export function track(...event: Event) {
  if (!KEY) return;
  if (!decided) {
    queue.push(event);
    return;
  }
  if (client && owner) client.capture(event[0], event[1] ?? {});
}
