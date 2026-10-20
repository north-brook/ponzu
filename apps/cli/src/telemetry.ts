import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
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

function readSettings(): Partial<Settings> {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as Partial<Settings>;
  } catch {
    return {};
  }
}

async function writeSettings(settings: Settings) {
  const path = settingsFile();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
}

async function settings(): Promise<Settings> {
  const current = readSettings();
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
  if (readSettings().enabled === false) return "turned off with `ponzu telemetry off`";
  return null;
}

export interface HostTelemetry extends Telemetry {
  /** Send what's queued. Short-lived processes call it before they exit. */
  shutdown(): Promise<void>;
}

/**
 * Anonymous usage for the Ponzu team: which tools agents call and how they
 * fail, which agents people use, how often the canvas is open, and feedback
 * agents send with send_feedback. Never design content, file names or paths.
 * Null when the person turned it off.
 */
export async function startTelemetry(base: {
  version: string;
  command: string;
}): Promise<HostTelemetry | null> {
  if (offBecause()) return null;
  let id: string;
  try {
    id = (await settings()).id;
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
  return {
    capture(event, properties) {
      client.capture({ distinctId: id, event, properties: { ...common, ...properties } });
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
      await client.shutdown(2000).catch(() => {});
    },
  };
}

/** One line the first time `ponzu serve` runs with telemetry on. */
export async function telemetryNotice(): Promise<string | null> {
  if (offBecause()) return null;
  const current = readSettings();
  if (current.noticed || !current.id) return null;
  await writeSettings({ ...current, id: current.id, noticed: new Date().toISOString() }).catch(
    () => {},
  );
  return "Ponzu sends anonymous usage (tool names, errors, versions; never your designs) to help us improve it. Turn it off with `ponzu telemetry off` or PONZU_TELEMETRY=0.";
}

/** `ponzu telemetry [on|off|status]` */
export async function telemetryCommand(arg = "status") {
  if (arg === "on" || arg === "off") {
    const current = await settings();
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
