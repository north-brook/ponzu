// The Vercel function: one Hono app, default-exported, on the Node runtime. `bun run build`
// bundles this file into dist/index.js, which is what Vercel serves (see vercel.json and the
// README for why the build is ours). It must export the app, never a server.
//
// Importing this file reads the environment and starts the real app. Nothing imports it but
// the build and `bun run dev`; clients take the app's type from `@ponzu/api/types`.
import { createApp } from "./create-app.ts";
import { createDeps } from "./deps/index.ts";
import { readEnv } from "./env.ts";

export default createApp(createDeps(readEnv(process.env)));
