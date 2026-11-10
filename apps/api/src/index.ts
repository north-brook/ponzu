// The Vercel function: one Hono app, default-exported, on the Node runtime. `bun run build`
// bundles this file into dist/index.js, which is what Vercel serves (see vercel.json and the
// README for why the build is ours). It must export the app, never a server.
import { createApp } from "./create-app.ts";
import { createDeps } from "./deps/index.ts";
import { readEnv } from "./env.ts";

export type { AppType } from "./create-app.ts";

export default createApp(createDeps(readEnv(process.env)));
