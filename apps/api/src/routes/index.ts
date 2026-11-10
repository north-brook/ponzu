import { Hono } from "hono";
import type { AppEnv } from "../http/context.ts";
import { auth } from "./auth.ts";
import { github } from "./github.ts";
import { health } from "./health.ts";
import { me } from "./me.ts";
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
  .route("/workspaces", workspaces);
