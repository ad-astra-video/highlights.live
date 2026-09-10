import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@highlights/events": fileURLToPath(new URL("./packages/events/src/index.ts", import.meta.url)),
      "@highlights/livepeer-session": fileURLToPath(new URL("./packages/livepeer-session/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "services/server/test/**/*.test.ts",
      "services/media/test/**/*.test.ts",
      "webapp/src/**/*.test.ts?(x)",
    ],
    environment: "node",
    testTimeout: 30000,
    // node:sqlite (and other experimental builtins) are not in Vite's
    // default external list — load them from Node at runtime, not via Vite.
    server: { deps: { external: [/^node:/] } },
  },
});
