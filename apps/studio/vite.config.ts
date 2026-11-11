import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { checkoutPort, sourceCheckout } from "../cli/src/source.ts";

// The server `bun run dev` starts from this checkout listens on the checkout's own port.
const checkout = sourceCheckout(fileURLToPath(import.meta.url));
const target =
  process.env.PONZU_SERVER ?? `http://127.0.0.1:${checkout ? checkoutPort(checkout) : 7777}`;

/*
 * The web fonts the app ships, every family and weight its screens use (the cloud screens' are in
 * src/cloud/styles/tokens.css). One link for every page, so the gallery measures what ships.
 */
const FONTS =
  "https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..600&family=Funnel+Display:wght@600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";

function webFonts(): Plugin {
  return {
    name: "ponzu-web-fonts",
    transformIndexHtml: () => [
      { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
      { tag: "link", attrs: { rel: "stylesheet", href: FONTS } },
    ],
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), webFonts()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      // The catalog's stream is a WebSocket under /api.
      "/api": { target, ws: true },
      "/mcp": target,
      "/files": target,
      // Designs on the person's other Macs, relayed by the server.
      "/peers": { target, ws: true },
      "/ws": { target: target.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // The cloud gallery (gallery.html) is dev-only; `--mode gallery` builds it alone for the
    // visual scripts (scripts/visual.ts), never into the app.
    rollupOptions:
      mode === "gallery"
        ? { input: fileURLToPath(new URL("./gallery.html", import.meta.url)) }
        : undefined,
  },
}));
