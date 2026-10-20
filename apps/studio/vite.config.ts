import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.PONZU_SERVER ?? "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/mcp": target,
      "/files": target,
      "/ws": { target: target.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
