import { Hono } from "hono";
import type { AppEnv } from "../http/context.ts";
import { auth } from "./auth.ts";
import { cron } from "./cron.ts";
import { designs } from "./designs.ts";
import { github } from "./github.ts";
import { health } from "./health.ts";
import { live } from "./live.ts";
import { me } from "./me.ts";
import { workspaceDesigns } from "./workspace-designs.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Everything under `/v1`, one sub-app per area. A new area is a file beside these and a line
 * here; the calls are chained so the routes' types reach `AppType`.
 */
export const v1 = new Hono<AppEnv>()
  .route("/health", health)
  .route("/auth", auth)
  .route("/me", me)
  .route("/github", github)
  .route("/workspaces/:workspaceId/designs", workspaceDesigns)
  .route("/workspaces", workspaces)
  .route("/designs", designs)
  .route("/live", live)
  .route("/cron", cron);
