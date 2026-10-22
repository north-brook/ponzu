import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.PONZU_SERVER ?? "http://127.0.0.1:7777";

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
