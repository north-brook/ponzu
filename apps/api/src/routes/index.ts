import { Hono } from "hono";
import type { AppEnv } from "../http/context.ts";
import { account } from "./account.ts";
import { auth } from "./auth.ts";
import { claude } from "./claude.ts";
import { cron } from "./cron.ts";
import { designPullRequest } from "./design-pull-request.ts";
import { designThread } from "./design-thread.ts";
import { designs } from "./designs.ts";
import { environments } from "./environments.ts";
import { github } from "./github.ts";
import { health } from "./health.ts";
import { live } from "./live.ts";
import { me } from "./me.ts";
import { notifications } from "./notifications.ts";
import { repoIdeas } from "./repo-ideas.ts";
import { runner } from "./runner.ts";
import { runnerPullRequest } from "./runner-pull-request.ts";
import { usage } from "./usage.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Everything under `/v1`, one sub-app per area. A new area is a file beside these and a line
 * here; the calls are chained so the routes' types reach `AppType`.
 */
export const v1 = new Hono<AppEnv>()
  .route("/health", health)
  .route("/auth", auth)
  .route("/me", me)
  .route("/me", notifications)
  .route("/me", account)
  .route("/claude", claude)
  .route("/github", github)
  .route("/workspaces", workspaces)
  .route("/designs", designs)
  .route("/designs", designThread)
  .route("/designs", designPullRequest)
  .route("/repos", repoIdeas)
  .route("/", environments)
  .route("/", usage)
  .route("/runner", runner)
  .route("/runner", runnerPullRequest)
  .route("/live", live)
  .route("/cron", cron);
