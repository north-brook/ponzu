/*
 * For tests only. The recorded vendor answers in these fixtures were taken before launch, while
 * dev still answered on api.ponzu.design and production's sign-in, Realtime and PostHog project
 * did not exist yet. A test that replays them checks them against infra as it was then:
 * today's infra/, with environments.json swapped for environments-before-launch.json.
 */
import { join } from "node:path";
import { type Infra, loadEnvironments, loadInfra } from "../desired.ts";

export const BEFORE_LAUNCH = join(import.meta.dir, "environments-before-launch.json");

export function infraBeforeLaunch(): Infra {
  return { ...loadInfra(), "environments.json": loadEnvironments(BEFORE_LAUNCH) };
}
