import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { readTailnet } from "@ponzu/server";
import type { Feedback, Telemetry } from "@ponzu/tools";
import { PostHog } from "posthog-node";
import { ponzuHome } from "./host.ts";

/**
 * The Ponzu project's ingestion key. Release builds inline it (the desktop
 * build's `--env`, from the release workflow), so only official builds
 * report; a checkout or fork without it sends nothing.
 */
const KEY = process.env.PONZU_POSTHOG_KEY;
const HOST = "https://us.i.posthog.com";

/**
 * Agent feedback lands as responses to this API survey, so the team reads it
 * in PostHog's Surveys tab. The question ids are the survey's own.
 */
const SURVEY = {
  id: "01a15b34-b883-0000-406c-c0fcbf06f72d",
  sentiment: {
    id: "3a7d04fa-29b3-4ddc-a071-ecf583638061",
    question: "How did Ponzu work for this?",
  },
  category: {
    id: "f424930c-628d-4524-81f2-5e644e21e10a",
    question: "What kind of feedback is it?",
  },
  summary: { id: "145ce2c0-deb4-4117-9b2d-63626e1f3982", question: "Summary" },
  details: { id: "bea78403-0940-4682-a22e-d07db89ef85f", question: "Details" },
};

const SENTIMENT: Record<Feedback["sentiment"], string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  mixed: "Mixed",
};
const CATEGORY: Record<Feedback["category"], string> = {
  bug: "Bug",
  missing_capability: "Missing capability",
  confusing_tool: "Confusing tool",
  praise: "Praise",
  other: "Other",
};

/** ~/.ponzu/telemetry.json: this install's anonymous id, and the person's choice. */
interface Settings {
  id: string;
  enabled?: boolean;
  /** When `ponzu serve` said telemetry is on. */
  noticed?: string;
}

const settingsFile = () => join(ponzuHome(), "telemetry.json");

/** The file's settings, `{}` when there's none yet, or null when it can't be read. */
function readSettings(): Partial<Settings> | null {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as Partial<Settings>;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

async function writeSettings(settings: Settings) {
  const path = settingsFile();
  await mkdir(dirname(path), { recursive: true });
  // Whole or not at all: a half-written file would lose the person's choice.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(tmp, path);
}

/** This install's settings, given an id. Null when the file can't be read: never replace it. */
async function settings(): Promise<Settings | null> {
  const current = readSettings();
  if (!current) return null;
  if (current.id) return current as Settings;
  const next = { ...current, id: randomUUID() };
  await writeSettings(next);
  return next;
}

const falsy = (v?: string) => v !== undefined && /^(0|false|off|no)$/i.test(v.trim());
const truthy = (v?: string) => v !== undefined && v.trim() !== "" && !falsy(v);

/** Why telemetry is off, or null when it's on. */
function offBecause(): string | null {
  if (!KEY) return "this build doesn't report usage";
  if (falsy(process.env.PONZU_TELEMETRY)) return "PONZU_TELEMETRY is off";
  if (truthy(process.env.DO_NOT_TRACK)) return "DO_NOT_TRACK is set";
  if (truthy(process.env.CI)) return "running in CI";
  const current = readSettings();
  if (!current) return "~/.ponzu/telemetry.json can't be read";
  if (current.enabled === false) return "turned off with `ponzu telemetry off`";
  return null;
}

/**
 * offBecause, rechecked at most every few seconds: hosts run for days, and
 * `ponzu telemetry off` in another terminal should stop them too.
 */
function onNow(): () => boolean {
  let checked = 0;
  let on = true;
  return () => {
    if (Date.now() - checked > 5_000) {
      checked = Date.now();
      on = !offBecause();
    }
    return on;
  };
}

/**
 * The person behind this install: a hash of their Tailscale user id, the same
 * on each of their Macs, so the id itself is never sent. Null without
 * Tailscale. Re-read every few minutes, for hosts that start before Tailscale
 * connects and then run for days.
 */
function tailscaleOwner(): () => Promise<string | null> {
  let checked = 0;
  let owner: Promise<string | null> = Promise.resolve(null);
  return () => {
    if (Date.now() - checked > 10 * 60_000) {
      checked = Date.now();
      owner = readTailnet()
        .then((n) => (n ? ownerHash(n.user) : null))
        .catch(() => null);
    }
    return owner;
  };
}

export const ownerHash = (user: string) =>
  createHash("sha256").update(`ponzu:tailscale:${user}`).digest("hex").slice(0, 32);

export interface HostTelemetry extends Telemetry {
  /** Send what's queued. Short-lived processes call it before they exit. */
  shutdown(): Promise<void>;
}

/**
 * Anonymous usage for the Ponzu team: which tools agents call and how they
 * fail, which agents people use, how often the canvas is open, and feedback
 * agents send with send_feedback. Never design content, file names or paths.
 * Events go out under this install's random id. With Tailscale, the install is
 * also aliased to its owner's hash, so PostHog counts one person's Macs, and
 * their events from before Tailscale connected, as one person.
 * Null when the person turned it off.
 */
export async function startTelemetry(base: {
  version: string;
  command: string;
}): Promise<HostTelemetry | null> {
  if (offBecause()) return null;
  let id: string;
  try {
    const current = await settings();
    if (!current) return null;
    id = current.id;
  } catch {
    // An unwritable home has no stable id to count it by.
    return null;
  }
  const client = new PostHog(KEY!, { host: HOST, flushAt: 20, flushInterval: 10_000 });
  // Network trouble is never the person's problem.
  client.on("error", () => {});
  const common = {
    version: base.version,
    command: base.command,
    surface: process.env.PONZU_DESKTOP ? "desktop" : "cli",
    os: platform(),
    arch: arch(),
  };
  const owner = tailscaleOwner();
  let aliased: string | null = null;
  /**
   * What an event needs from the Tailscale read: aliases this install to its
   * owner once per process (PostHog ignores a repeat), and leaves events
   * without an owner personless, so an install alone gets no person profile.
   * An install already joined to one owner stays with them: PostHog refuses
   * to merge two people.
   */
  const person = async () => {
    const o = await owner();
    if (o && o !== aliased) {
      client.alias({ distinctId: o, alias: id });
      aliased = o;
    }
    return o ? {} : { $process_person_profile: false };
  };
  const on = onNow();
  // Events wait for the first Tailscale read, in order, stamped when they happened.
  let queue = Promise.resolve();
  return {
    capture(event, properties) {
      if (!on()) return;
      const timestamp = new Date();
      queue = queue
        .then(person)
        .then((profile) =>
          client.capture({
            distinctId: id,
            event,
            timestamp,
            properties: { ...common, ...profile, ...properties },
          }),
        )
        // One lost event must not stop the ones after it.
        .catch(() => {});
    },
    async feedback(f) {
      // Off since this process started: honour it.
      if (offBecause()) return false;
      const answers: Record<string, string> = {
        [SURVEY.sentiment.id]: SENTIMENT[f.sentiment],
        [SURVEY.category.id]: CATEGORY[f.category],
        [SURVEY.summary.id]: f.summary,
      };
      if (f.details) answers[SURVEY.details.id] = f.details;
      try {
        await client.captureImmediate({
          distinctId: id,
          event: "survey sent",
          properties: {
            ...common,
            ...(await person()),
            $survey_id: SURVEY.id,
            $survey_iteration: null,
            $survey_submission_id: randomUUID(),
            $survey_completed: true,
            $survey_questions: [SURVEY.sentiment, SURVEY.category, SURVEY.summary, SURVEY.details],
            ...Object.fromEntries(
              Object.entries(answers).map(([q, v]) => [`$survey_response_${q}`, v]),
            ),
            tool: f.tool,
            client: f.client,
          },
        });
        return true;
      } catch {
        return false;
      }
    },
    async shutdown() {
      await queue;
      await client.shutdown(2000).catch(() => {});
    },
  };
}

/** One line the first time `ponzu serve` runs with telemetry on. */
export async function telemetryNotice(): Promise<string | null> {
  if (offBecause()) return null;
  const current = readSettings();
  if (!current?.id || current.noticed) return null;
  await writeSettings({ ...current, id: current.id, noticed: new Date().toISOString() }).catch(
    () => {},
  );
  return "Ponzu sends anonymous usage (tool names, errors, versions; never your designs) to help us improve it. Turn it off with `ponzu telemetry off` or PONZU_TELEMETRY=0.";
}

/** `ponzu telemetry [on|off|status]` */
export async function telemetryCommand(arg = "status") {
  if (arg === "on" || arg === "off") {
    const current = await settings();
    if (!current) {
      console.error(`Can't read ${settingsFile()}. Fix or delete it, then try again.`);
      process.exit(1);
    }
    await writeSettings({ ...current, enabled: arg === "on" });
  } else if (arg !== "status") {
    console.error("Usage: ponzu telemetry [on|off|status]");
    process.exit(1);
  }
  const why = offBecause();
  console.log(
    why
      ? `Telemetry is off (${why}).`
      : "Telemetry is on: Ponzu sends anonymous usage (tool names, errors, versions; never your designs). Turn it off with `ponzu telemetry off`.",
  );
}
