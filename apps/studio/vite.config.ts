import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { checkoutPort, sourceCheckout } from "../cli/src/source.ts";

// The server `bun run dev` starts from this checkout listens on the checkout's own port.
const checkout = sourceCheckout(fileURLToPath(import.meta.url));
const target =
  process.env.PONZU_SERVER ?? `http://127.0.0.1:${checkout ? checkoutPort(checkout) : 7777}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
