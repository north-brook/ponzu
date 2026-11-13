import { Hono } from "hono";
import type { AppEnv } from "../http/context.ts";
import { account } from "./account.ts";
import { agentConnections } from "./agent-connections.ts";
import { auth } from "./auth.ts";
import { canvasPullRequest } from "./canvas-pull-request.ts";
import { canvasPullRequests } from "./canvas-pull-requests.ts";
import { canvasThread } from "./canvas-thread.ts";
import { canvases } from "./canvases.ts";
import { claude } from "./claude.ts";
import { cron } from "./cron.ts";
import { email } from "./email.ts";
import { environments } from "./environments.ts";
import { github } from "./github.ts";
import { health } from "./health.ts";
import { live } from "./live.ts";
import { mcp } from "./mcp.ts";
import { me } from "./me.ts";
import { notifications } from "./notifications.ts";
import { oauth } from "./oauth.ts";
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
  .route("/canvases", canvases)
  .route("/canvases", canvasThread)
  .route("/canvases", canvasPullRequest)
  .route("/canvases", canvasPullRequests)
  .route("/repos", repoIdeas)
  .route("/", environments)
  .route("/", usage)
  .route("/runner", runner)
  .route("/runner", runnerPullRequest)
  .route("/agent-connections", agentConnections)
  .route("/oauth", oauth)
  .route("/mcp", mcp)
  .route("/live", live)
  .route("/cron", cron)
  .route("/email", email);
