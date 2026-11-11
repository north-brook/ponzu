import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/*
 * The web fonts the app ships, every family and weight its screens use (the cloud screens' are in
 * src/cloud/styles/tokens.css). One link for every page, so the gallery measures what ships.
 * Inter's own italic too: the thread's asides are set in it, and a slanted upright reads worse.
 */
const FONTS =
  "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,400..600;1,14..32,400..600&family=Funnel+Display:wght@600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";

function webFonts(): Plugin {
  return {
    name: "ponzu-web-fonts",
    transformIndexHtml: () => [
      { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
      { tag: "link", attrs: { rel: "stylesheet", href: FONTS } },
    ],
  };
}

/*
 * `bun run dev` serves the studio on Ponzu Cloud in memory (src/app/fake-host.ts); inside the
 * desktop app, `PONZU_STUDIO_URL=http://localhost:5173 bun run start` loads it from here on the
 * real API.
 */
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), webFonts()],
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
