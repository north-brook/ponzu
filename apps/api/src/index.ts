// The Vercel function: one Hono app, default-exported, on the Node runtime. `bun run build`
// bundles this file into dist/index.js, which is what Vercel serves (see vercel.json and the
// README for why the build is ours). It must export the app, never a server.
//
// Importing this file reads the environment and starts the real app. Nothing imports it but
// the build and `bun run dev`; clients take the app's type from `@ponzu/api/types`.
import { createApp } from "./create-app.ts";
import { createDeps } from "./deps/index.ts";
import { readEnv } from "./env.ts";

const deps = createDeps(readEnv(process.env));

// Node ends the process on a rejection nobody handled, and an instance serves many requests
// at once. Work a request leaves running goes through `deps.background`, which never rejects;
// this is for the promise that slipped past it, so one request's bug is a log line and not
// everyone's failed request.
process.on("unhandledRejection", (error) => deps.log.error("unhandled_rejection", { error }));

export default createApp(deps);
