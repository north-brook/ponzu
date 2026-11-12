import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/*
 * `bun run dev` serves the studio on Ponzu Cloud in memory (src/app/fake-host.ts); inside the
 * desktop app, `PONZU_STUDIO_URL=http://localhost:5173 bun run start` loads it from here on the
 * real API.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Written only for PostHog's CLI to upload, which the desktop package does before packing
    // and then deletes them (apps/desktop/scripts/sourcemaps.ts): the app never ships a map.
    sourcemap: Boolean(process.env.POSTHOG_CLI_API_KEY && process.env.POSTHOG_CLI_PROJECT_ID),
    // The cloud gallery (gallery.html) is dev-only; `--mode gallery` builds it alone for the
    // visual scripts (scripts/visual.ts), never into the app.
    rollupOptions:
      mode === "gallery"
        ? { input: fileURLToPath(new URL("./gallery.html", import.meta.url)) }
        : undefined,
  },
}));
