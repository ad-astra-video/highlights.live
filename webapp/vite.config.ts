import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: the API server runs on :3000. Proxy all its routes so the SPA can use
// relative URLs (same origin) — no CORS, no hard-coded host.
const apiProxies = ["/auth", "/billing", "/jobs", "/highlights", "/clips", "/stripe", "/dev", "/health"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4174,
    proxy: Object.fromEntries(apiProxies.map((p) => [p, { target: "http://127.0.0.1:3000", changeOrigin: true }])),
  },
  build: {
    outDir: "dist",
  },
});
